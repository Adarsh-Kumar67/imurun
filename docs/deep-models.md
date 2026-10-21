# Deep models — running more than the machine can hold

Most laptops can hold a 7B model in memory. Nothing about that is a law of
nature: it is a property of the engine. IMURUN's default engine (llama.cpp)
keeps every weight resident, so the model has to fit. The **deep engine**
does not: it keeps one layer in memory at a time and streams the rest from
disk.

That is how a 32B or a 72B model answers on a machine with a 4 GB card.

## What it costs

Be clear about the trade before choosing it:

| | llama.cpp (a GGUF model) | the deep engine (AirLLM) |
| --- | --- | --- |
| Model size | must fit in memory | limited by disk |
| Weight format | GGUF | the original Hugging Face weights |
| Speed | seconds | **minutes** per answer |
| Streaming | token by token | the whole answer at once |
| Disk | one file | tens of gigabytes |

The deep engine is not a faster path. It is the path for a model that
otherwise cannot run here at all.

## Setting it up

The engine is Python (AirLLM and PyTorch), so it has its own virtualenv under
`~/.imurun/engines/airllm/venv` — it never touches the Python you use for your
own work.

```bash
imurun setup --deep           # airllm + torch, about 2.5 GB
```

Then point IMURUN at a model:

```bash
imurun deep                                    # what can run, and whether it can
imurun deep Qwen/Qwen2.5-Coder-32B-Instruct    # a known deep model
imurun deep owner/any-hugging-face-repo        # any repo
imurun deep D:\weights\my-model                # a local directory of weights
```

`imurun deep` remembers its choice, so the next `imurun` uses it.

In the interface, `/deep` opens the same list, and `/model` has a **Run a
model larger than memory…** entry. Choosing one does not start a download —
the first answer does, because a 70B download is a decision, not a side
effect.

## What you see while it works

Three different waits, each with its own line:

1. **Installing the engine** — pip's own output, one line at a time
   (`imurun setup --deep`, or `/deep` the first time).
2. **Loading the weights** — AirLLM reports its progress on stderr; the
   server reads it and exposes it, and the status line shows
   `deep engine · loading 42% · layers stream from disk`.
3. **Generating** — `deep engine · thinking in one pass · this is the slow
   part`. AirLLM returns the answer in one piece, so pretending to stream
   would be a lie.

The server answers `/health` from the moment it starts, which is what makes
that possible: the load does not block the health check.

## How it fits together

```
imurun
  └─ runtime ── engine = airllm
       └─ python -m imurun.airllm_server --model <repo> --port 42425
            ├─ GET  /health               stage, percent, detail
            ├─ GET  /props                the context window
            ├─ POST /v1/chat/completions  OpenAI-compatible
            └─ POST /unload               release the weights
```

The server ships **inside** the IMURUN binary as text and is written to
`~/.imurun/engines/airllm/airllm_server.py` when needed, so an npm install or
a standalone binary needs no extra files. It is standard library only;
`torch` and `airllm` are imported when a model is loaded, never at start.

The rest of IMURUN talks to it exactly as it talks to llama.cpp — the same
OpenAI-shaped API, the same supervisor, the same idle unload, the same
heartbeat that frees the memory when the last terminal closes.

## Troubleshooting

**"Python 3 is required for the deep engine."**
Install Python 3.11–3.13 from [python.org](https://python.org). PyTorch
usually lags the newest Python by a release, and `pip install airllm` fails
on an interpreter it has no wheels for. If you need a specific interpreter,
set `runtime.airllm.python` in `imurun.json`.

**"AirLLM is not importable."**
`imurun setup --deep`, or `pip install airllm` in the engine's virtualenv.
The error text from pip is shown; a missing wheel for your Python version is
the usual cause.

**It is very slow.**
Expected. A deep answer is one pass over the whole model, streamed from disk.
`runtime.airllm.maxNewTokens` (default 1024) is the main lever; smaller
answers finish sooner.

**A gated repo.**
`meta-llama/Llama-3.3-70B-Instruct` and `google/gemma-3-…` need the licence
accepted on Hugging Face and a token available to the Python process
(`HF_TOKEN`).

## Configuration

```json
{
  "runtime": {
    "airllm": {
      "python": "C:/Python313/python.exe",
      "compression": "4bit",
      "maxNewTokens": 1024,
      "timeoutMinutes": 45
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `python` | the engine's virtualenv | interpreter to use |
| `compression` | `4bit` | `4bit`, `8bit`, or `none` |
| `maxNewTokens` | `1024` | longest answer in one pass |
| `timeoutMinutes` | `45` | how long to wait before giving up |
