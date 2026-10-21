# IMURUN documentation

This is the documentation index for IMURUN, a local-first AI coding agent for the
terminal. It is written for version **0.1.11** and describes only behaviour that
exists in this repository today.

**What this covers:** what IMURUN is, how the documentation is organised, which
guide to read for a given task, and the exact counts and locations the rest of
these pages rely on.

## What IMURUN is

IMURUN runs large language models on your own machine and drives them as a coding
agent in the terminal. It probes your hardware, recommends models that actually
fit, downloads them with live progress and checksums, manages a local inference
runtime, and frees the model from memory the moment you close the terminal. It
works offline, sends no telemetry, and every dependency it ships is free and open
source. You can add an online provider if you want one, but local is the default.

- Website: <https://imutechz.in>
- Publisher: ImuTechz
- Author: Shubham Mallick (<dev@imutechz.in>)
- License: MIT © 2026 ImuTechz
- Version documented here: 0.1.11

## Which guide to read

| Guide | Read it when you want to |
| --- | --- |
| [Getting started](getting-started.md) | Install, run your first session, and understand the moving parts. |
| [Installation](installation.md) | Choose between npm, a standalone binary, or running from source. |
| [The TUI](the-tui.md) | Learn the screen, the keyboard, the mouse, and the status line. |
| [Slash commands](slash-commands.md) | Look up every `/command` and what it does. |
| [CLI reference](cli-reference.md) | Look up every `imurun` subcommand, flag, and example. |
| [Configuration](configuration.md) | Edit `imurun.json` and know every field's type and default. |
| [Models](models.md) | Browse the bundled catalog and understand recommendations. |
| [Local models](local-models.md) | Understand hardware detection, engine choice, install flow, and storage. |
| [Deep models](deep-models.md) | Run a model larger than memory — AirLLM streams it from disk, slowly. |
| [Runtime](runtime.md) | Understand the inference daemon, idle unload, and context sizing. |
| [Providers](providers.md) | Add an online provider, or point IMURUN at a compatible endpoint. |
| [Agents](agents.md) | Use and write working modes with their own prompt and tools. |
| [Skills](skills.md) | Use the built-in skill library, route it, and import packs. |
| [Tools](tools.md) | See every tool, its arguments, and its limits. |
| [Memory](memory.md) | Understand durable notes, session digests, and the progress ledger. |
| [RAG](rag.md) | Understand the offline project index behind `code_search`. |
| [Engines](engines.md) | Understand the learned decisions: research, notes, skills. |
| [Response engine](response-engine.md) | See how IMURUN learns the answer style you want, and how to reset it. |
| [Permissions](permissions.md) | Control what runs without asking. |

## The numbers in this documentation

These counts were read directly from the source at version 0.1.11.

| Thing | Count | Where it is defined |
| --- | --- | --- |
| Packages | 7 | `packages/*` |
| Tools in the base registry | 16 | `packages/core/src/tool/registry.ts` |
| Tools in the interactive UI | 17 | base registry plus `task`, added in `packages/tui/src/app.ts` |
| Slash commands | 33 | `packages/tui/src/commands.ts` |
| CLI subcommands | 12 | `packages/cli/src/index.ts` |
| Provider presets | 11 | `packages/core/src/provider/presets.ts` |
| Catalog models | 16 | `packages/modelmgr/src/registry/catalog.ts` |
| Built-in skills | 53 | `packages/core/src/agent/skill-catalog.ts` |
| Built-in agents | 4 | `packages/core/src/agent/agents.ts` |

## Where IMURUN keeps its files

All persistent state lives under `~/.imurun` (override with the `IMURUN_HOME`
environment variable). Project-specific files live under `.imurun/` inside the
project directory. The layout is described in full in
[Local models](local-models.md#where-files-live) and
[Configuration](configuration.md#where-config-lives).

## Conventions used across these pages

- Commands you type are shown in fenced `bash` blocks without a leading prompt.
- Text the agent or IMURUN prints is shown in indented or fenced blocks and is
  never meant to be copied verbatim.
- Paths use forward slashes in examples; on Windows the same locations exist
  under `%USERPROFILE%\.imurun`.
- `~` means your home directory.
- "The agent" is the model currently driving a session; "you" are the person at
  the terminal.
