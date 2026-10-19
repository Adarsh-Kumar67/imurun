# Runtime

**What this covers:** the local inference runtime — what it is, how IMURUN starts
and stops it, how closing your terminal frees the model's memory, how the model
is kept warm, and how the context window is chosen. The model files themselves
are covered in [Local models](local-models.md).

## What the runtime is

The runtime is a managed process that serves a local model over an
OpenAI-compatible HTTP API on `127.0.0.1`. By default it is **llama.cpp**'s
`llama-server`; an **Ollama** engine is also supported. IMURUN decides when to
start it, when to stop it, and how to load the model, so you do not manage the
server by hand.

The default port is **42425** (`runtime.port`, 1024–65535). The server only
listens on loopback.

## Engines

```
imurun runtime status
```

The status output lists the engines and whether each is available:

| Engine | Notes |
| --- | --- |
| `llama.cpp (bundled)` | The default. Installed automatically with the first model (see [Local models](local-models.md#choosing-the-inference-engine)). |
| `ollama` | Used when `runtime.engine` is `ollama`, or when you start the runtime with `--engine ollama`. Requires a model name such as `qwen2.5-coder:7b`. |

Select the engine in config with `runtime.engine`, or per-start with
`--engine llama-cpp|ollama`. With the llama.cpp engine you must have a GGUF
model; the runtime refuses to start without one and tells you how to install or
select one.

## Starting, stopping, and supervising

```
imurun runtime status
imurun runtime start                 # start and supervise; Ctrl+C stops it
imurun runtime start --background    # start with a detached supervisor
imurun runtime stop                  # stop everything and free RAM
imurun runtime restart               # stop, then start
imurun runtime logs [--tail 40]      # tail ~/.imurun/logs/runtime.log
```

There are two ways the runtime is supervised:

- **Foreground** (`imurun runtime start`). The supervisor runs inside your
  command: it starts the model, then waits. `Ctrl+C` stops it and frees memory.
- **Background** (`--background`). A detached supervisor process is spawned that
  outlives your terminal. It unloads the model when it goes idle or when the last
  client disconnects. Stop it with `imurun runtime stop`.

In the interactive UI, the runtime is started for you when a local model is
selected. `/runtime` shows its status and `/runtime stop` stops it.

## How memory is freed when you close the terminal

The runtime does not belong to a single client. Instead:

- Each client session writes a **heartbeat** every 5 seconds while it is alive.
- The supervisor considers a heartbeat **stale after 15 seconds**.
- When the last client's heartbeat is gone, the supervisor waits out a **grace
  period (30 seconds by default)** and then stops the engine, releasing the RAM.

This is what makes "close the terminal and the model is unloaded" true, and it is
also why the model is *not* yanked out from under an open UI: as long as one
client is attached, the runtime stays up. The heartbeat timer is intentionally
referenced, not unref'd, so a quiet long-lived client does not accidentally look
disconnected.

A one-shot `imurun run` uses the same machinery: it registers a heartbeat and, if
it started the runtime itself, stops it again on exit — but only when no other
client is attached.

## Idle unload

When no request has been sent for `runtime.idleUnloadMinutes` (10 by default),
the supervisor unloads the model to give the memory back. The next request starts
it again. Set it to `0` to never unload; raise it to keep the model warm for
longer.

The related `runtime.shutdownGraceSeconds` (30 by default) is how long the server
is kept alive after the last session ends.

## Context sizing and YaRN

Local models advertise windows that are far larger than a laptop can hold in KV
cache, so IMURUN is deliberate about the context it loads:

- The engine is **always** started with an explicit `--ctx-size`. llama.cpp's own
  default is 4096, which would truncate ordinary conversations.
- The size is the model's own trained window, capped at **32768 tokens**
  (`AUTO_CONTEXT_CAP`), unless you set `runtime.contextSize` or the model's
  window is unknown (in which case the cap is used).
- When the requested size is larger than the model's trained window, IMURUN
  extends it with **YaRN** RoPE scaling (`--rope-scaling yarn`, a derived
  `--rope-scale`, and `--yarn-orig-ctx` set to the trained window). This is only
  switched on when it is actually needed, because extended context costs KV
  memory and a little quality.
- `runtime.ropeScaling` can be `auto` (YaRN when needed), `none` (disable),
  `linear`, or `yarn`. `runtime.ropeScale` forces an explicit factor.

The **engine is the authority on the window it actually loaded.** After starting,
IMURUN asks llama.cpp's `/props` endpoint for the real `n_ctx` and budgets the
agent's requests against that number, not against what it asked for. If the
engine loaded a different size, it logs a warning and uses the engine's answer.

`imurun runtime status` prints the context window and its scaling, for example
`65,536 tokens · yarn ×2.0 from 32,768`.

## The llama.cpp command line

For reference, IMURUN starts `llama-server` with a tuned set of flags. It sets
`--host 127.0.0.1`, `--batch-size 2048`, `--ubatch-size 512`, `--no-webui`,
`--metrics`, `--cache-reuse 256`, `--jinja`, `--flash-attn auto` (unless flash
attention is disabled), and `--log-colors off`. It adds `--alias` so the server's
model list matches the id the agent asks for, and `--mmproj` for vision models.
GPU offload follows `runtime.gpuLayers`: `-1` leaves `--n-gpu-layers` unset so
llama.cpp fits the model to the GPU itself, `0` forces CPU, and a positive value
offloads that many layers. Threads default to half the cores.

Server stderr is redirected straight into `~/.imurun/logs/runtime.log` at the OS
level, so it never pins the client's event loop open, and crash output is
recorded.

## Health and state

`imurun runtime status` reports whether the runtime is actually serving (it
probes the engine's health endpoint), the engine and port, the model, the context
window, the uptime, the supervisor pid, and any health detail. If state is
recorded but the engine is not reachable, it says `stopped` and notes the stale
state. If nothing is running, it tells you how to start it.

State lives in `~/.imurun/runtime/` (`state.json`, `supervisor.pid`, and the
per-session heartbeats). Stale state is cleaned up automatically before a start.

## Configuration

The knobs are all under `runtime` in config. The most useful ones:

| Field | Effect |
| --- | --- |
| `engine` | `llama-cpp` or `ollama`. |
| `engineVariant` | Which llama.cpp build to prefer. |
| `port` | The local API port. |
| `idleUnloadMinutes` | Idle minutes before the model is unloaded (`0` never). |
| `shutdownGraceSeconds` | Grace period after the last client leaves. |
| `threads` | CPU threads (`0` auto). |
| `gpuLayers` | GPU offload (`-1` auto, `0` CPU only). |
| `contextSize` | Context override (`0` uses the model's window). |
| `ropeScaling` / `ropeScale` | Context extension beyond the trained window. |
| `flashAttention` | Whether to pass `--flash-attn auto`. |
| `speculativeDecoding` | Opt into speculative decoding when a draft model exists. |

See [Configuration](configuration.md#runtime) for types and defaults.
