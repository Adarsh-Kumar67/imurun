# IMURUN

**Your code. Your machine. Your model.**

IMURUN is a local-first AI coding agent for the terminal. It installs, manages,
and runs large language models entirely on your own hardware — CPU or GPU — with
no cloud dependency, no telemetry, and no separate runtime to configure. You run
`imurun`, answer one question about whether to work locally or online, and start
coding. Local models are the default, and everything IMURUN needs to run them
ships with it.

- Website: <https://imutechz.in>
- Documentation: [`docs/`](docs/README.md)
- Publisher: ImuTechz · Author: Shubham Mallick (<dev@imutechz.in>)
- Version: **0.1.3** · License: MIT © 2026 ImuTechz

```
┌──────────────────────────────────────────────┬──────────────────────┐
│ ❯ fix the login bug in auth.ts               │  CONTEXT             │
│                                              │  ████████░░░░  24%   │
│   I'll look at auth.ts first.                │  1.6k / 32k tok      │
│   ⠿ read src/auth.ts · tracing the call path │                      │
│   ███████░░░░░░░░  46%                       │  AGENT               │
│   ✔ found the null deref on line 14          │  build               │
│                                              │                      │
│ ❯ also add a test for it                     │  MODEL               │
│                                              │  qwen2.5-coder-7b    │
│   2 steps · 2235+140 tokens · 41s            │                      │
│                                              │  PERMISSIONS         │
│ ╭─ message ───────────────────── esc stops ╮ │  auto                │
│ │ ❯ _                                      │ │  DIRECTORY           │
│ ╰──────────────────── Ln 1, Col 1 ─────────╯ │  …/ImuTechz/IMU CLI  │
│  / commands · shift+tab agent · approval …   │                      │
└──────────────────────────────────────────────┴──────────────────────┘
```

## Using local models, directly

The point of IMURUN is to make a local model as easy to use as any hosted one,
without giving up the machine it runs on.

- **First run just works** — the first time you start IMURUN it asks one
  question: run models on this machine, or online? Choose local and it probes your
  hardware, picks the best-fitting coding model, installs the right inference
  engine, and downloads the model — no flags, no manual engine choice, no config
  file. Every step of the wizard can be stepped back with `Esc`.
- **It shows you what fits** — before you commit, IMURUN scores your machine
  (RAM, VRAM, CPU, disk) into a tier and recommends models that actually run well
  on it, with an estimated speed and the storage each one needs. You can see
  exactly how much space a download will take, and how much will be left, before
  it starts.
- **One keypress to install** — pick a model and IMURUN downloads it with a single
  animated progress line, verifies the checksum, resumes an interrupted download
  from where it stopped, and installs the engine for your platform first. If the
  first engine build will not run, it silently falls back to one that does.
- **The model is warm while you work, gone when you leave** — a managed background
  daemon keeps the model in memory for near-instant replies. Close the terminal
  and every byte of RAM is returned to your system. You never have a stray server
  process.
- **Everything you need is bundled** — the inference engine, the model catalog,
  the index, and the memory store all run locally. There is no account, no API
  key, and no network required for local use.
- **Offline is a first-class mode** — search, recall, and the project index all
  run in-process with no model, no network, and nothing loaded, so IMURUN works on
  a plane or a locked-down machine the same way it does at home.

## Highlights

- **Interactive terminal UI** — run `imurun`. Chat with streaming replies, inline
  tool cards, and permission prompts; switch models and agents on the fly; and
  drive everything with slash commands. See [The TUI](docs/the-tui.md).
- **Storage-aware installs** — before any download IMURUN shows what the model
  needs, what is free, and what will remain, and refuses to start if the disk is
  too full. Every byte is accounted for. See
  [Local models](docs/local-models.md).
- **Easy cleanup** — list, remove (from the `/model` picker or the CLI), or wipe
  models and engine binaries with one command. Reclaimed space is reported, and
  interrupted downloads are swept up too.
- **Persistent memory** — readable, editable notes that survive sessions, plus a
  summary of each session and a per-project progress ledger, all stored locally as
  plain files. Standing instructions are picked up as you type ("always use tabs
  here"), personal details are remembered, and anything you ask it to keep as a
  secret is encrypted at rest and never put in a prompt. See
  [Memory](docs/memory.md).
- **A second brain** — typed cards for people, projects, goals, ideas and
  lessons, written as ordinary markdown in an Obsidian-compatible vault. Cards
  strengthen each time they are used and fade with disuse, so what matters keeps
  reaching the prompt; the vault scores its own health, repairs its links, and
  keeps a map of content. Your persona file personalises every session. See
  [Memory](docs/memory.md#the-vault--the-second-brain).
- **Offline, self-updating RAG** — your codebase is indexed locally and kept fresh
  as you work, so the agent can search everything you have written with no
  internet, no embedding service, and no API key. The best-matching pieces are put
  in front of the model automatically, and the panel names the files they came
  from. See [RAG](docs/rag.md).
- **Full agent toolset** — read, write, edit, shell, glob, grep, project-wide
  search, web search, web fetching, screenshots, sub-agents, and durable memory.
  See [Tools](docs/tools.md).
- **Built for small models** — every request is budgeted against the window the
  engine actually loaded. Older turns are folded into a session summary instead of
  being sent again, and a long answer is carried on rather than cut off. Big files
  are written in pieces, the way a person would.
- **Resumable work** — a per-project ledger records what was written and what is
  still half-done, so an interrupted run picks up exactly where it stopped.
- **Self-adjusting skills and agents** — IMURUN ships **53** task skills (from
  building a website to reviewing a diff) and picks the right one for a request
  automatically. Ask it to create a new skill or agent and it writes the file for
  you. See [Skills](docs/skills.md) and [Agents](docs/agents.md).
- **Optional online providers** — prefer a cloud model? Add any OpenAI-compatible
  provider (OpenAI, Anthropic, Google, OpenRouter, Groq, NVIDIA, DeepSeek,
  Mistral, xAI, Together, or a custom endpoint) with one command. See
  [Providers](docs/providers.md).

## Quickstart

```bash
# install — pick whichever suits your machine
npm install -g imurun
npm install -g https://github.com/shubham001312/imurun/releases/latest/download/imurun-npm.tgz
pip install imurun

# open the interactive UI — on a fresh machine this sets up the engine and the
# best-fitting model automatically, then you can just start talking
imurun

# or run a single task non-interactively
imurun run "explain what this project does"

# see what this machine can actually run
imurun models

# prefer to choose yourself? install any catalog model (engine included),
# with live progress, resume support, and checksum verification
imurun models install qwen2.5-coder-7b
```

The model is loaded once and stays warm while you work. Close the terminal — or
run `imurun runtime stop` — and the model is unloaded, with every byte of RAM
returned to your system. New here? Start with
[Getting started](docs/getting-started.md).

## Interactive UI

Run `imurun` (or `imurun chat`) for a full-screen chat session with a scrolling
transcript, streamed answers, and inline tool cards. Everything is also reachable
from slash commands (press `Tab` to complete, `/help` for the list):

```
/help                 list commands
/model  /models       show or switch models · list installed + recommendations
/install  /remove     install a model (with disk impact) · delete one
/agent  /agents       switch or list agents
/skills               list, find, or sync the skill library
/tools                tools available to the current agent
/new  /sessions       start or resume sessions (/resume <n|id>)
/cwd  /status         show or change the working directory · full status
/memory [query]       what IMURUN remembers · search it (`vault` for the second brain)
/copy [list | <n>]    copy the last answer, or a code block, to the clipboard
/compact              free context: fold older turns into the session summary
/rag [status|index|search <q>|clear]   the code index
/permission [auto|manual|readonly]     who approves tool calls
/queue [edit <n>|drop <n>|clear]       messages waiting behind the current turn
/runtime [status|stop]  control the local inference runtime
/clear  /exit         clear the screen · leave (frees the model)
```

Type a normal message to send it. Files written or commands run prompt for
approval first — press `a` to always allow, `d` to always deny, or `/exit` to
leave. `/permission auto` approves everything from then on. The full list is in
[Slash commands](docs/slash-commands.md).

### Keyboard and mouse

| key                        | does                                                     |
| -------------------------- | -------------------------------------------------------- |
| `Enter`                    | send the message                                          |
| `Shift+Enter` / `Ctrl+J`   | newline inside the draft                                  |
| `Up` / `Down`              | move within a draft · walk history · scroll when empty    |
| `PgUp` / `PgDn`            | scroll the transcript (8 lines) · wheel scrolls too       |
| `Shift+Tab`                | switch agent (with a transition)                          |
| `Esc`                      | clear the draft · interrupt a running turn                |
| `Ctrl+Z`                   | take the last queued message back into the prompt          |
| `Ctrl+C` twice             | exit                                                      |
| mouse click in the prompt  | place the caret where you clicked                         |

While the agent is working, anything you type is **queued** and sent the moment
the turn ends; `/queue edit 1` or `Ctrl+Z` pulls one back to rewrite it, and
`/queue drop 1` cancels it. Press `Esc` to interrupt instead.

Scrolling is pinned to the line you are reading: output that arrives while you
are looking back appears below the fold instead of pushing the text you were
reading off the screen. `PgDn` (or `Esc`) returns to the live end.

### Context, compaction and resumability

Local models have a small window, so IMURUN treats it as a hard budget:

- The engine is always started with an explicit context size.
- Everything sent is measured against the window: the system prompt, recalled
  memory, tool arguments, and history. Tool arguments are compacted before they
  are replayed, so a file you wrote ten turns ago does not fill the window today.
- When history no longer fits, the oldest turns are folded into a durable session
  summary that stays in the system prompt — you keep the thread, the model gets
  its room back. If the engine still refuses a request for size, IMURUN compacts
  harder and retries; you never see the raw error.
- An answer cut off by the output limit is continued automatically, with an
  instruction not to repeat what was already written.
- `/compact` does this on demand.

For large files the model is told to write in pieces (`write` with
`mode: "create"`, then `mode: "append"`), and each write is recorded in a
per-project ledger (`~/.imurun/memory/ledger/`) that the agent reads back when it
resumes — so "continue where you left off" actually works.

### Agents

Agents are named working modes that differ in prompt, tools, and (optionally)
model. IMURUN ships four:

| agent     | mode     | what it does                                              |
| --------- | -------- | --------------------------------------------------------- |
| `build`   | primary  | the default coding agent — reads, writes, edits, runs     |
| `plan`    | primary  | read-only: explores and proposes a plan, never edits      |
| `general` | primary  | general purpose with every tool                           |
| `explore` | subagent | fast, read-only search used by the `task` tool            |

Switching is instant (`/agent plan`), and the active agent shapes the system
prompt and the tool set. The agent can delegate focused work to a subagent
through the `task` tool, which runs in its own context window and reports back.

Add your own by dropping a markdown file in `~/.imurun/agents/<id>.md` (or
`<project>/.imurun/agents/<id>.md` for a project-local one):

```markdown
---
name: Docs Writer
description: Writes and edits documentation
tools: read, write, edit, grep
---
You write clear, concise documentation and keep it in sync with the code.
```

Interrupted or failed runs never leave a model in RAM: the runtime is owned by
the supervisor and is torn down as soon as the last client leaves. See
[Agents](docs/agents.md).

### Skills

Skills are short, focused ways of working — "build a landing page", "review a
diff", "write a migration" — that IMURUN picks for a request automatically and
feeds to the model as part of the prompt. They never clutter the chat; the one in
use appears as a chip in the status line.

IMURUN ships **53** of them, and can pull a wider community pack:

```bash
imurun skills                 # everything available, with what it's for
imurun skills find "landing page"
imurun skills show build-website
imurun skills sync            # clone a vetted pack from GitHub (license-checked)
```

Synced skills land in `~/.imurun/skills/` as plain markdown with an `origin` and
`license` header, and never shadow a built-in one. Drop your own file in the same
directory — or ask IMURUN to write it — and it is picked up immediately. See
[Skills](docs/skills.md).

### Managing storage

```bash
imurun models                 # what's installed and how much disk it uses
imurun models remove <id>     # delete one model (frees its space)
imurun models remove --all    # delete every model (asks for --yes)
imurun models clean           # show what can be reclaimed
imurun models clean --yes     # free it all (add --engine to drop engine builds)
```

Add `--keep-files` to unregister a model while keeping the GGUF on disk. Model
files, engines, and their space are described in
[Local models](docs/local-models.md).

### Permissions

A fresh install runs in **auto** mode (nothing prompts). `/permission manual`
makes IMURUN ask before writing files or running commands, and
`/permission readonly` lets it look but never touch. Rules let you allow or deny
specific commands and paths. See [Permissions](docs/permissions.md).

## Documentation

Full guides live in [`docs/`](docs/README.md):

| Guide | Guide |
| --- | --- |
| [Getting started](docs/getting-started.md) | [Providers](docs/providers.md) |
| [Installation](docs/installation.md) | [Runtime](docs/runtime.md) |
| [The TUI](docs/the-tui.md) | [Agents](docs/agents.md) |
| [Slash commands](docs/slash-commands.md) | [Skills](docs/skills.md) |
| [CLI reference](docs/cli-reference.md) | [Tools](docs/tools.md) |
| [Configuration](docs/configuration.md) | [Memory](docs/memory.md) |
| [Models](docs/models.md) | [RAG](docs/rag.md) |
| [Local models](docs/local-models.md) | [Permissions](docs/permissions.md) |

## Status

IMURUN is under active construction. Milestones:

- [x] M1 — Workspace, shared schemas, utilities
- [x] M2 — Core config + storage + sessions
- [x] M3 — Providers + agent loop + core tools
- [x] M4 — Runtime daemon (local inference)
- [x] M5 — Model manager (hardware detection, one-click install)
- [x] M6 — Terminal UI (chat, streamed tools, slash commands, agents)
- [x] M7 — Memory (durable notes, session summaries, progress ledger)
- [x] M8 — Offline RAG
- [x] M9 — Web tools
- [x] M10 — Skills & agents (skill catalog, routing, sync, subagents)
- [x] M11 — Permissions, context management, compaction
- [x] M12 — Packaging & distribution

## Packaging and distribution

IMURUN ships two ways, both produced by one script (`bun run package`):

- **npm** — `npm install -g imurun`. The published payload is a single
  self-contained JavaScript bundle (no `node_modules`), run by a tiny launcher.
  Bun is declared as the engine because the session store needs `bun:sqlite`.
- **Standalone executables** — `imurun-<os>-<arch>` compiled with
  `bun build --compile`, so the runtime is embedded and Bun is not required.
  These are staged as `@imurun/<os>-<arch>` packages that the main package
  depends on *optionally*; the launcher uses the native binary when a matching
  one is installed and falls back to the bundle otherwise.

```bash
bun run package                     # bundle + stage the npm package
bun run package:binaries            # ...and compile for this machine
bun run package -- --targets=bun-windows-x64,bun-linux-x64,bun-darwin-arm64
bun run package -- --out=dist/release
```

Everything is staged under `dist/package/` (gitignored); the script only writes
files - it never touches the network or the registry. `bun run package` prints
the exact `npm install -g` line for the staged build. The published version
comes from `packages/cli/package.json`, so a release is a one-line bump.
`bun run release` publishes the npm tarball and compiled binaries as GitHub
release assets. See [Installation](docs/installation.md).

## Repository layout

```
packages/
  schema/    Shared types and validation (zod)
  util/      Zero-dependency helpers (fs, crypto, format, logging, GGUF)
  core/      Agent engine: sessions, tools, providers, permissions,
             memory, RAG, skills
  modelmgr/  Hardware detection + one-click model installation
  runtime/   Background inference daemon
  cli/       Command-line interface
  tui/       Terminal user interface
scripts/     Build, packaging, demos, and diagnostics
```

## Development

Requires [Bun](https://bun.sh) 1.2+ and Node.js 20+.

```bash
bun install        # install workspace dependencies
bun run typecheck  # type check everything
bun test           # run the test suite
bun run build      # bundle every package
bun run dev        # launch the CLI in development mode
bun run package    # stage the npm package + standalone binaries
```

On Windows, `imurun.cmd` runs the CLI from source without a global install
(`imurun.cmd chat`).

Diagnostics that print a full frame or explain a runtime decision without a
terminal:

```bash
bun run scripts/demo-tui-frame.ts    # render one complete UI frame as text
bun run scripts/diag-context.ts      # the window each model loads, and why
bun run scripts/demo-run.ts          # an end-to-end agent turn with a stub model
```

## License

MIT © 2026 ImuTechz. IMURUN and its dependencies are free and open source, and
the agent sends no telemetry.
