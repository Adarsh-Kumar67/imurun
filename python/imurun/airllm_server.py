"""IMURUN's deep engine: AirLLM behind an OpenAI-compatible server.

AirLLM keeps one layer of a model in memory at a time and streams the rest
from disk, so a 32B or 70B model can answer on a laptop with a 4 GB card.
It is slow, and it is honest about that: AirLLM returns a finished string,
so the streaming endpoint sends one chunk rather than pretending to stream.

Run it directly::

    python -m imurun.airllm_server --model Qwen/Qwen2.5-Coder-32B-Instruct \
        --port 42425 --compression 4bit

The server is standard library only. ``torch`` and ``airllm`` are imported
when a model is loaded, never before, so ``/health`` answers immediately and
the interface can show the load instead of a blank wait.

Endpoints
---------
``GET  /health``               stage, progress and the loaded model
``GET  /props``                the context window, for request budgeting
``GET  /v1/models``            the OpenAI model list
``POST /v1/chat/completions``  chat, streaming or not
``POST /unload``               release the model from memory
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

__version__ = "1.0.0"

STATE: dict[str, Any] = {
    "stage": "starting",
    "detail": "",
    "percent": None,
    "error": None,
    "startedAt": time.time(),
    "loadedAt": None,
    "requests": 0,
    "tokens": 0,
    "lastLatencyMs": None,
}

MODEL: dict[str, Any] = {
    "repo": "",
    "name": "",
    "compression": "4bit",
    "maxNewTokens": 1024,
    "contextLength": 8192,
    "loaded": None,
    "lock": threading.Lock(),
}

_PERCENT = re.compile(r"(\d{1,3})%")
_PAIR = re.compile(r"\b(\d{1,3})/(\d{1,5})\b")


class ProgressTap:
    """A stream that passes through, and learns how far the load has got.

    AirLLM (and its loader) report progress on stderr as percentages or as
    ``item/total`` pairs. Reading those, rather than guessing, is what lets the
    interface show a real bar instead of an endless spinner.
    """

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def write(self, text: str) -> int:
        try:
            self._stream.write(text)
            self._stream.flush()
        except Exception:  # noqa: BLE001 - a closed terminal is not a crash
            pass
        line = text.strip()
        if line:
            match = _PERCENT.search(line)
            if match:
                value = int(match.group(1))
                if 0 <= value <= 100:
                    STATE["percent"] = value
            else:
                pair = _PAIR.search(line)
                if pair:
                    done, total = int(pair.group(1)), int(pair.group(2))
                    if total > 0 and done <= total:
                        STATE["percent"] = round(done * 100 / total)
            if len(line) <= 160:
                STATE["detail"] = line
        return len(text)

    def flush(self) -> None:
        try:
            self._stream.flush()
        except Exception:  # noqa: BLE001
            pass

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


def _install_progress_tap() -> None:
    if not isinstance(sys.stderr, ProgressTap):
        sys.stderr = ProgressTap(sys.stderr)  # type: ignore[assignment]


def _import_error() -> str | None:
    """Why the deep engine cannot run, or None when it can."""
    try:
        import airllm  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - any import failure is the reason
        return f"AirLLM is not importable: {exc}"
    try:
        import torch  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        return f"torch is not importable: {exc}"
    return None


def load_model() -> Any:
    """Loads once, in a background thread the first time it is needed.

    The first chat request waits here. ``/health`` does not, so the interface
    can say "loading 42%" instead of timing out.
    """
    with MODEL["lock"]:
        if MODEL["loaded"] is not None:
            return MODEL["loaded"]

        reason = _import_error()
        if reason:
            raise RuntimeError(
                f"{reason}. Install the deep engine with: pip install airllm"
            )

        STATE["stage"] = "loading"
        STATE["detail"] = f"loading {MODEL['repo']}"
        STATE["percent"] = 0
        _install_progress_tap()

        from airllm import AutoModel  # imported late on purpose

        started = time.time()
        try:
            model = AutoModel.from_pretrained(
                MODEL["repo"],
                compression=MODEL["compression"],
            )
        except TypeError:
            # Older AirLLM releases do not take ``compression``.
            model = AutoModel.from_pretrained(MODEL["repo"])
        except Exception as exc:  # noqa: BLE001
            STATE["stage"] = "error"
            STATE["error"] = str(exc)
            STATE["detail"] = str(exc)
            raise

        MODEL["loaded"] = model
        STATE["stage"] = "ready"
        STATE["percent"] = 100
        STATE["loadedAt"] = time.time()
        STATE["detail"] = f"{MODEL['name']} loaded in {time.time() - started:.0f}s"

        tokenizer = getattr(model, "tokenizer", None)
        window = getattr(tokenizer, "model_max_length", None) or getattr(
            getattr(model, "config", None), "max_position_embeddings", None
        )
        if isinstance(window, int) and 0 < window < 10_000_000:
            MODEL["contextLength"] = window
        return model


def count_tokens(text: str) -> int:
    model = MODEL["loaded"]
    tokenizer = getattr(model, "tokenizer", None) if model else None
    if tokenizer is not None and hasattr(tokenizer, "encode"):
        try:
            return len(tokenizer.encode(text))
        except Exception:  # noqa: BLE001 - a tokenizer quirk is not worth a crash
            pass
    # Word-and-punctuation pieces track BPE closely enough for budgeting.
    return max(1, len(re.findall(r"\w+|[^\w\s]", text, re.UNICODE))) if text else 0


def render_chat(messages: list[dict[str, Any]]) -> str:
    """Uses the model's own chat template when it has one."""
    model = MODEL["loaded"]
    tokenizer = getattr(model, "tokenizer", None) if model else None
    if tokenizer is not None and hasattr(tokenizer, "apply_chat_template"):
        try:
            return tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
        except Exception:  # noqa: BLE001 - fall through to the plain form
            pass
    system = "\n\n".join(
        str(m.get("content", "")) for m in messages if m.get("role") == "system"
    )
    turns = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(
                str(part.get("text", ""))
                for part in content
                if isinstance(part, dict)
            )
        if role == "user":
            turns.append(f"User: {content}")
        elif role == "assistant":
            turns.append(f"Assistant: {content}")
    body = "\n\n".join(turns)
    return f"{system}\n\n{body}\n\nAssistant:" if system else f"{body}\n\nAssistant:"


def generate(
    messages: list[dict[str, Any]], max_new_tokens: int, temperature: float
) -> tuple[str, int]:
    model = load_model()
    prompt = render_chat(messages)
    prompt_tokens = count_tokens(prompt)

    STATE["stage"] = "generating"
    STATE["detail"] = f"{prompt_tokens} tokens in"
    STATE["percent"] = None
    started = time.time()

    options: dict[str, Any] = {"max_new_tokens": max_new_tokens}
    if temperature > 0:
        options["temperature"] = temperature
    try:
        output = model.generate([prompt], **options)
    except TypeError:
        # AirLLM releases differ in which knobs they accept.
        output = model.generate([prompt], max_new_tokens=max_new_tokens)
    except Exception as exc:  # noqa: BLE001
        STATE["stage"] = "ready"
        STATE["error"] = str(exc)
        raise

    text = output if isinstance(output, str) else str(output[0]) if output else ""
    # AirLLM returns the prompt and the continuation together on some models.
    if text.startswith(prompt):
        text = text[len(prompt) :]

    STATE["stage"] = "ready"
    STATE["percent"] = 100
    STATE["requests"] += 1
    STATE["tokens"] += prompt_tokens + count_tokens(text)
    STATE["lastLatencyMs"] = round((time.time() - started) * 1000)
    STATE["detail"] = f"answered in {time.time() - started:.1f}s"
    return text, count_tokens(text)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = f"imurun-airllm/{__version__}"

    # �"?�"? plumbing �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        sys.stderr.write(f"[airllm] {fmt % args}\n")

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    # �"?�"? routes �"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?�"?

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            # 200 even while loading: the server is up and says what it is doing.
            self._send(
                200,
                {
                    "status": "ok",
                    "stage": STATE["stage"],
                    "detail": STATE["detail"],
                    "percent": STATE["percent"],
                    "error": STATE["error"],
                    "model": MODEL["name"],
                    "repo": MODEL["repo"],
                    "loaded": MODEL["loaded"] is not None,
                    "uptimeMs": round((time.time() - STATE["startedAt"]) * 1000),
                    "requests": STATE["requests"],
                    "tokens": STATE["tokens"],
                    "lastLatencyMs": STATE["lastLatencyMs"],
                },
            )
        elif path == "/props":
            self._send(
                200,
                {
                    "default_generation_settings": {
                        "n_ctx": MODEL["contextLength"]
                    },
                    "model": MODEL["name"],
                },
            )
        elif path == "/v1/models":
            self._send(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": MODEL["name"] or MODEL["repo"],
                            "object": "model",
                            "owned_by": "imurun",
                        }
                    ],
                },
            )
        elif path == "/status":
            self._send(200, {**STATE, "loaded": MODEL["loaded"] is not None})
        else:
            self._send(404, {"error": {"message": f"no route {path}"}})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/unload":
            with MODEL["lock"]:
                MODEL["loaded"] = None
            STATE["stage"] = "idle"
            STATE["detail"] = "model released"
            STATE["percent"] = None
            try:
                import gc

                gc.collect()
                torch = sys.modules.get("torch")
                if torch is not None and getattr(torch, "cuda", None):
                    torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
            self._send(200, {"ok": True})
            return

        if path != "/v1/chat/completions":
            self._send(404, {"error": {"message": f"no route {path}"}})
            return

        body = self._body()
        messages = body.get("messages") or []
        if not isinstance(messages, list) or not messages:
            self._send(400, {"error": {"message": "messages is required"}})
            return

        max_new_tokens = int(body.get("max_tokens") or MODEL["maxNewTokens"])
        temperature = float(body.get("temperature") or 0.0)

        try:
            if body.get("stream"):
                self._stream(messages, max_new_tokens, temperature)
            else:
                text, tokens = generate(messages, max_new_tokens, temperature)
                self._send(
                    200,
                    {
                        "id": f"chatcmpl-airllm-{int(time.time() * 1000)}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": MODEL["name"] or MODEL["repo"],
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": text},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 0,
                            "completion_tokens": tokens,
                            "total_tokens": tokens,
                        },
                    },
                )
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send(500, {"error": {"message": str(exc)}})

    def _stream(
        self, messages: list[dict[str, Any]], max_new_tokens: int, temperature: float
    ) -> None:
        # AirLLM produces the whole answer in one pass, so streaming here would
        # be fiction. One honest chunk, then the terminator, is the truth.
        text, _ = generate(messages, max_new_tokens, temperature)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        # SSE has no length, so the end of the reply is the end of the
        # connection. Saying so explicitly is what lets a client stop reading.
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()
        chunk = {
            "id": f"chatcmpl-airllm-{int(time.time() * 1000)}",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": MODEL["name"] or MODEL["repo"],
            "choices": [
                {
                    "index": 0,
                    "delta": {"role": "assistant", "content": text},
                    "finish_reason": None,
                }
            ],
        }
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
        final = {
            "id": chunk["id"],
            "object": "chat.completion.chunk",
            "created": chunk["created"],
            "model": chunk["model"],
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        self.wfile.write(f"data: {json.dumps(final)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="imurun.airllm_server")
    parser.add_argument("--model", required=True, help="Hugging Face repo id or a local directory")
    parser.add_argument("--name", default="", help="the name IMURUN asks for")
    parser.add_argument("--port", type=int, default=42425)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--compression", default="4bit", choices=["4bit", "8bit", "none"])
    parser.add_argument("--max-new-tokens", type=int, default=1024)
    parser.add_argument("--warmup", action="store_true", help="load the model before the first request")
    args = parser.parse_args(argv)

    MODEL["repo"] = args.model
    MODEL["name"] = args.name or args.model.rstrip("/").split("/")[-1]
    MODEL["compression"] = args.compression
    MODEL["maxNewTokens"] = args.max_new_tokens

    # A model path on this machine is a directory, not a repo id.
    if os.path.isdir(args.model):
        MODEL["repo"] = os.path.abspath(args.model)

    STATE["stage"] = "idle"
    STATE["detail"] = f"ready to load {MODEL['name']}"

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(
        f"imurun airllm server on http://{args.host}:{args.port} "
        f"for {MODEL['name']} ({args.compression})",
        flush=True,
    )

    if args.warmup:
        def warm() -> None:
            try:
                load_model()
            except Exception:  # noqa: BLE001 - reported through /health
                traceback.print_exc()

        threading.Thread(target=warm, name="airllm-warmup", daemon=True).start()

    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
