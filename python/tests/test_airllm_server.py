"""The deep engine's server, without needing torch.

AirLLM is a two-gigabyte dependency and these tests must run on a machine
that has never seen it, so the model call is replaced. Everything else - the
HTTP routes, the OpenAI shape, the streaming terminator, the progress tap that
reads the loader's output - is the real code.
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from typing import Any

from imurun import airllm_server


class ServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved_generate = airllm_server.generate
        self.saved_state = dict(airllm_server.STATE)
        self.saved_model = {
            key: airllm_server.MODEL[key] for key in ("name", "repo", "loaded", "contextLength")
        }

        airllm_server.MODEL["name"] = "test-model"
        airllm_server.MODEL["repo"] = "owner/test-model"
        airllm_server.MODEL["loaded"] = object()
        airllm_server.MODEL["contextLength"] = 32768
        airllm_server.STATE.update({"stage": "ready", "detail": "ready", "percent": 100, "error": None})

        def fake_generate(messages: list[dict[str, Any]], max_new_tokens: int, temperature: float):
            self.assertEqual(messages[0]["role"], "user")
            return f"echo: {messages[0]['content']}", 4

        airllm_server.generate = fake_generate  # type: ignore[assignment]

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), airllm_server.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        airllm_server.generate = self.saved_generate  # type: ignore[assignment]
        airllm_server.STATE.clear()
        airllm_server.STATE.update(self.saved_state)
        airllm_server.MODEL.update(self.saved_model)

    def get(self, path: str) -> tuple[int, Any]:
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def post(self, path: str, payload: dict[str, Any]) -> tuple[int, Any]:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body)

    def test_health_says_the_server_is_up_and_what_it_is_doing(self) -> None:
        status, body = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["stage"], "ready")
        self.assertTrue(body["loaded"])

    def test_health_answers_while_the_model_is_still_loading(self) -> None:
        airllm_server.STATE.update({"stage": "loading", "percent": 42})
        airllm_server.MODEL["loaded"] = None
        status, body = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["stage"], "loading")
        self.assertEqual(body["percent"], 42)

    def test_a_chat_completion_has_the_openai_shape(self) -> None:
        status, body = self.post(
            "/v1/chat/completions",
            {"messages": [{"role": "user", "content": "hello"}]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["object"], "chat.completion")
        self.assertEqual(body["choices"][0]["message"]["role"], "assistant")
        self.assertEqual(body["choices"][0]["message"]["content"], "echo: hello")
        self.assertEqual(body["model"], "test-model")

    def test_streaming_ends_with_done(self) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/chat/completions",
            data=json.dumps(
                {"messages": [{"role": "user", "content": "hi"}], "stream": True}
            ).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read().decode("utf-8")
        self.assertIn("data: [DONE]", body)
        self.assertIn("echo: hi", body)

    def test_props_reports_the_window_for_budgeting(self) -> None:
        _, body = self.get("/props")
        self.assertEqual(body["default_generation_settings"]["n_ctx"], 32768)

    def test_the_model_list_names_the_model(self) -> None:
        _, body = self.get("/v1/models")
        self.assertEqual(body["data"][0]["id"], "test-model")

    def test_a_bad_request_is_refused_cleanly(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/v1/chat/completions", {"messages": []})
        self.assertEqual(caught.exception.code, 400)

    def test_an_unknown_route_is_a_404(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get("/nope")
        self.assertEqual(caught.exception.code, 404)

    def test_a_failed_generation_is_a_json_error_the_client_can_show(self) -> None:
        def boom(*_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("AirLLM is not importable: No module named 'airllm'")

        airllm_server.generate = boom  # type: ignore[assignment]
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post("/v1/chat/completions", {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(caught.exception.code, 500)
        body = json.loads(caught.exception.read().decode("utf-8"))
        self.assertIn("AirLLM is not importable", body["error"]["message"])

    def test_unload_releases_the_model(self) -> None:
        self.post("/unload", {})
        self.assertIsNone(airllm_server.MODEL["loaded"])


class EngineErrorTest(unittest.TestCase):
    """A missing deep engine is reported where the interface looks for it."""

    def test_the_import_failure_reaches_health_and_the_reply(self) -> None:
        saved_error = airllm_server._import_error
        saved_loaded = airllm_server.MODEL["loaded"]
        saved_state = dict(airllm_server.STATE)
        airllm_server._import_error = lambda: "AirLLM is not importable: No module named 'airllm'"
        airllm_server.MODEL["loaded"] = None
        try:
            with self.assertRaises(RuntimeError) as caught:
                airllm_server.load_model()
            self.assertIn("pip install airllm", str(caught.exception))
            self.assertEqual(airllm_server.STATE["stage"], "error")
            self.assertIn("pip install airllm", airllm_server.STATE["error"])
            self.assertTrue(airllm_server.STATE["detail"])
        finally:
            airllm_server._import_error = saved_error  # type: ignore[assignment]
            airllm_server.MODEL["loaded"] = saved_loaded
            airllm_server.STATE.clear()
            airllm_server.STATE.update(saved_state)


class ProgressTest(unittest.TestCase):
    """The loader's own output is where real progress comes from."""

    def setUp(self) -> None:
        airllm_server.STATE["percent"] = None
        airllm_server.STATE["detail"] = ""

    def test_a_percentage_is_read(self) -> None:
        tap = airllm_server.ProgressTap(_Sink())
        tap.write("Loading layer 12/80 - 15%\n")
        self.assertEqual(airllm_server.STATE["percent"], 15)

    def test_a_pair_is_read_when_there_is_no_percentage(self) -> None:
        tap = airllm_server.ProgressTap(_Sink())
        tap.write("Fetching files: 3/8\n")
        self.assertEqual(airllm_server.STATE["percent"], 38)

    def test_nonsense_is_not_progress(self) -> None:
        tap = airllm_server.ProgressTap(_Sink())
        tap.write("already up to date\n")
        self.assertIsNone(airllm_server.STATE["percent"])

    def test_the_line_is_kept_for_the_interface(self) -> None:
        tap = airllm_server.ProgressTap(_Sink())
        tap.write("Loading 42%\n")
        self.assertEqual(airllm_server.STATE["detail"], "Loading 42%")
        self.assertIn("Loading 42%", tap._stream.text())


class _Sink:
    """A stand-in for stderr that remembers what was written."""

    def __init__(self) -> None:
        self._parts: list[str] = []

    def write(self, text: str) -> int:
        self._parts.append(text)
        return len(text)

    def flush(self) -> None:
        return None

    def text(self) -> str:
        return "".join(self._parts)


class ChatTest(unittest.TestCase):
    def test_a_plain_conversation_is_rendered_with_roles(self) -> None:
        text = airllm_server.render_chat(
            [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
                {"role": "user", "content": "again"},
            ]
        )
        self.assertIn("be brief", text)
        self.assertIn("User: hi", text)
        self.assertIn("Assistant: hello", text)
        self.assertTrue(text.rstrip().endswith("Assistant:"))

    def test_a_multimodal_prompt_keeps_its_text(self) -> None:
        text = airllm_server.render_chat(
            [{"role": "user", "content": [{"type": "text", "text": "look here"}]}]
        )
        self.assertIn("look here", text)

    def test_token_counting_is_never_zero_for_text(self) -> None:
        self.assertGreater(airllm_server.count_tokens("hello world"), 0)
        self.assertEqual(airllm_server.count_tokens(""), 0)


if __name__ == "__main__":
    unittest.main()
