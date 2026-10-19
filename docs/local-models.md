# Local models

**What this covers:** what IMURUN probes about your machine, how it decides which
inference engine to install, exactly what happens during a model install
(including the storage check and the live progress line), where every file ends
up, and how to reclaim space. It is the mechanics behind [Models](models.md).

## Detecting your hardware

The first time it needs to, IMURUN probes the machine and caches the result in
`~/.imurun/hardware.json` for seven days. Every probe is best-effort: a tool that
is missing never breaks detection.

| Part | How it is found |
| --- | --- |
| CPU | The OS CPU list; cores are half the thread count. |
| RAM | Total and available system memory. |
| GPUs (Windows) | `nvidia-smi` for NVIDIA cards, then WMI display adapters for AMD and Intel, skipping virtual and remote adapters. |
| GPUs (macOS) | Apple Silicon unified memory, or `system_profiler` for discrete AMD cards on Intel Macs. |
| GPUs (Linux) | `nvidia-smi` for NVIDIA, then `lspci` for others. |
| Disk | Free space on the volume the model store lives on. |

The profile is scored 0–100 (RAM up to 40 points, best GPU up to 40, CPU up to
20) and bucketed into a tier. The tier, the usable RAM, and the best GPU's VRAM
drive the fit and speed estimates described in [Models](models.md#how-a-model-is-chosen-for-your-machine).

`imurun models --refresh` (or `imurun models list --refresh`) forces a fresh
probe instead of using the cache. The `imurun models` header shows the detected
summary, the tier and score, and storage usage.

## Choosing the inference engine

IMURUN bundles **llama.cpp**. The `imurun models install` command ensures a
working `llama-server` binary exists, downloading the right prebuilt build for
your platform and GPU and verifying that it actually runs. If the first choice
will not run, it falls back to the next build automatically, so you never pick an
engine by hand.

The build preference order per platform is:

| Platform | Order (first is tried first) |
| --- | --- |
| Windows, NVIDIA present | vulkan → cuda → cpu |
| Windows, other usable GPU | vulkan → cpu |
| Windows, no usable GPU | cpu |
| macOS | metal |
| Linux, NVIDIA | cuda → vulkan → cpu |
| Linux, AMD | rocm → vulkan → cpu |
| Linux, other GPU | vulkan → cpu |
| Linux, no GPU | cpu |

Vulkan leads on Windows and Linux because it works on virtually any modern GPU,
needs no CUDA runtime, and downloads in about 30 MB; CUDA and ROCm follow for
maximum speed. The CPU build is always the last resort.

You can override the choice with the `engineVariant` config field (see
[Configuration](configuration.md#runtime)) or the `IMURUN_LLAMA_VARIANT`
environment variable. Accepted values are `auto`, `vulkan`, `cuda`, `rocm`,
`metal`, and `cpu`.

Engine builds come from the official llama.cpp releases. `GITHUB_TOKEN` is sent
when querying the releases API to avoid rate limits. Builds live under
`~/.imurun/engines/llama.cpp/<release>/`, and the verified one is recorded in
`active.json`. `imurun models engine` installs or updates the engine explicitly.

As a last-resort safety net, if `llama-server` fails to start at run time — a
missing driver, say — IMURUN force-reinstalls the portable CPU build once and
retries, without you choosing anything.

## What happens during an install

Installing a model is a single command with no manual steps. Before a byte is
downloaded it reports the storage impact; then it downloads the model, verifies
it, and registers it. The phases and their share of the progress are:

| Phase | Weight | What happens |
| --- | --- | --- |
| `resolve` | 2% | Look up the catalog entry, pick the quantization, ask Hugging Face for the file size and checksum. |
| `disk-check` | 3% | Compute the required space and refuse if the disk is too full. |
| `engine` | 10% | Ensure a working llama.cpp binary (download and verify if missing). |
| `download` | 72% | Download the GGUF, resumable and checksummed. |
| `mmproj` | 8% | Download the vision projector, for vision models only. |
| `register` | 3% | Record the model in the installed registry. |
| `done` | 2% | Report completion. |

### The storage check

Before downloading, IMURUN computes:

- the file size,
- the space actually required — the file size times a 1.25 safety factor plus 1
  GB of headroom,
- the free space on the target volume,
- the estimated free space once the download finishes,
- total bytes currently used by installed models, and the total after this
  install.

If the disk is too full it refuses to start and tells you how much is needed and
how much is free. On a success it also prints `needs X · Y free → ~Z left after`.

### Downloading

Downloads are **resumable**: the file is written to a `.part` file and resumed
with an HTTP range request, so an interrupted download continues instead of
starting over. Each file is retried up to three times, and the result is verified
against the SHA-256 checksum reported by Hugging Face. Partial `.part` files are
swept up by `imurun models clean`.

### The progress line

Live progress is rendered on a **single animated line** — a spinner, a 20-cell
bar, the percentage, the transfer rate, and an ETA — so a long download does not
scroll your terminal. When output is not a terminal (a pipe or a log), progress
is printed as one line per 10% instead.

## Where files live

Everything under `~/.imurun` (override the root with `IMURUN_HOME`):

| Path | Holds |
| --- | --- |
| `imurun.json` | Global configuration. |
| `models/installed.json` | The registry of installed models. |
| `models/gguf/<id>-<quant>.gguf` | The model weights. |
| `models/gguf/<id>-mmproj.gguf` | A vision model's projector. |
| `engines/llama.cpp/<release>/` | Downloaded engine builds. |
| `engines/llama.cpp/active.json` | The build that runs on this machine. |
| `hardware.json` | Cached hardware profile (seven days). |
| `logs/runtime.log` | The runtime log (server stderr). |
| `memory/notes.md`, `memory/index.json` | Durable notes and the memory index. |
| `memory/sessions/<id>.md` | One digest per summarized session. |
| `memory/ledger/<hash>.json` | The per-project progress ledger. |
| `memory/rag/<name>-<hash>.json` | A project's RAG index snapshot. |
| `skills/`, `agents/` | User and imported skills and agents. |
| `data/imurun.db`, `data/projects/<hash>.db` | Global and per-project SQLite databases (WAL mode). |
| `runtime/state.json`, `runtime/supervisor.pid`, `runtime/sessions/*.hb` | Runtime state, supervisor pid, and client heartbeats. |

Per project, IMURUN also writes:

| Path | Holds |
| --- | --- |
| `<project>/.imurun/PLAN.md` | The written plan (goal, approach, steps). |
| `<project>/.imurun/todos.md` | The live checklist. |
| `<project>/.imurun/agents/`, `<project>/.imurun/skills/` | Project-local agents and skills (these win over global ones). |

The databases are created and migrated on first use; the only migration so far is
`001_init`, which creates the sessions, messages, events, key/value, permissions,
and migrations tables.

## Removing and reclaiming space

```bash
imurun models remove <id>          # delete one model, report the space freed
imurun models remove --all --yes   # delete every registered model
imurun models remove <id> --keep-files   # unregister but keep the GGUF
imurun models clean                # show what can be reclaimed
imurun models clean --yes          # free it all (models + partial downloads)
imurun models clean --yes --engine # ...and remove the engine binaries too
```

`clean` lists the models and (with `--engine`) the engine binaries that would be
removed, the total reclaimable, and deletes only when given `--yes`. It also
prunes interrupted partial downloads.

## First-run automatic setup

On a fresh machine with no model, `imurun run "..."` sets everything up by itself
with no prompts: it detects hardware, picks the best-fitting catalog model, shows
which one it chose, installs the engine and the model, and runs the task. This is
what makes the first command work on a machine IMURUN has never seen. Pass
`--no-install` to disable it and handle setup yourself.

## Next

- Understand the daemon and context sizing: [Runtime](runtime.md).
- Tune engine, context, and threads: [Configuration](configuration.md#runtime).
