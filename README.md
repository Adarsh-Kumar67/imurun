# IMURUN

**Your code. Your machine. Your model.**

IMURUN is a local-first AI coding agent for the terminal. It installs, manages,
and runs large language models entirely on your own hardware — CPU or GPU —
with zero cloud dependency, zero telemetry, and zero cost. Bring an API key
only if you want to: local models are the default.

```
┌──────────────────────┬──────────────────────────────────────────────┐
│  CONTEXT             │ ❯ fix the login bug in auth.ts               │
│  ████████░░░░  24%   │                                              │
│  1.6k / 32k tok      │   I'll look at auth.ts first.                │
│                      │   ⠿ read src/auth.ts · tracing the call path │
│  AGENT               │   ███████░░░░░░░  46%                        │
│  build               │   ✔ found the null deref on line 14          │
│                      │                                              │
│  MODEL               │ ❯ also add a test for it                     │
│  qwen2.5-coder-7b    │                                              │
│                      │   2 steps · 2235+140 tokens · 41s            │
│  PERMISSIONS         │                                              │
│  manual              │ ╭─ message ────────────────────── esc stops ╮ │
│                      │ │ ❯ _                                       │ │
│  DIRECTORY           │ ╰───────────────────────────────────────────╯ │
│  …/ImuTechz/IMU CLI  │  / commands · shift+tab agent · approval …    │
└──────────────────────┴──────────────────────────────────────────────┘
```

## Highlights

- **Interactive terminal UI** — just run `imurun`. Chat with streaming replies,
  inline tool cards, and permission prompts, switch models and agents on the fly,
  and drive everything with slash commands.
- **One-click local models** — IMURUN inspects your RAM, VRAM, CPU, and disk,
  then shows a catalog of coding models that actually fit your machine. Pick
  one, watch the live download progress, and start coding. Everything else is
  automatic.
- **Zero-setup first run** — on a brand-new machine, `imurun run "…"` installs the
  correct inference engine and the best-fitting model for your hardware by
  itself, with no prompts and no configuration. The engine build is verified and
  silently falls back to a compatible one if the first choice will not run.
- **Storage-aware installs** — before any download IMURUN shows exactly how much
  space the model needs, how much is free, and how much will remain, and refuses
  to start if the disk is too full. Every byte is accounted for.
- **Easy cleanup** — list, remove, or wipe models and engine binaries with a single
  command (`imurun models remove`, `imurun models clean`). Reclaimed space is
  reported, and interrupted downloads are swept up too.
- **Background runtime** — a managed inference daemon keeps your model warm in
  memory for near-instant replies, and frees every byte of RAM the moment you
  close the terminal.
- **Persistent memory** — IMURUN remembers your credentials (encrypted with the
  OS keychain), your coding style, and summaries of every past session, then
  personalizes every new conversation with them.
- **Offline self-updating RAG** — your codebase is indexed locally and kept fresh
  as you work, so the agent can search everything you have written — no internet
  required, no embeddings service, no API key.
- **Full agent toolset** — read, write, edit, shell, glob, grep, code search, web
  search, web fetching, sub-agents, and durable memory.
- **Built for small models** — every request is budgeted against the window the
  engine actually loaded. Older turns are folded into a session summary instead of
  being sent again, and a long answer is carried on rather than cut off. Big files
  are written in pieces, the way a person would, so a small model never has to
  produce one enormous tool call.
- **Resumable work** — a per-project ledger records what was written and what is
  still half-done, so an interrupted run picks up exactly where it stopped instead
  of starting over.
- **Self-adjusting skills & agents** — IMURUN ships 50+ task skills (from web
  building to writing and data work) and picks the right one for a request
  automatically; ask it to create a new skill or agent and it writes, registers,
  and tests it for you.
- **API mode** — prefer a cloud model? Add any OpenAI-compatible provider
  (OpenAI, Anthropic, Google, OpenRouter, Groq, LM Studio, vLLM...) with one
  command.

## Quickstart

```bash
# install (needs Bun 1.2+ on PATH — https://bun.sh)
npm install -g imurun

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

The model is loaded once and stays warm while you work. Close the terminal —
or run `imurun runtime stop` — and the model is unloaded, with every byte of
RAM returned to your system.

## Interactive UI

Run `imurun` (or `imurun chat`) for a full-screen-feel chat session with a
scrolling transcript, streamed answers, and inline tool cards. Everything is
also reachable from slash commands (press `Tab` to complete, `/help` for the
list):

```
/help                 list commands
/model  /models       show or switch models · list installed + recommendations
/install  /remove     install a model (with disk impact) · delete one
/agent  /agents       switch or list agents
/skills               list, find, or sync the skill library
/tools                tools available to the current agent
/new  /sessions       start or resume sessions (/resume <n|id>)
/cwd  /status         show or change the working directory · full status
/memory [query]       what IMURUN remembers · search it
/compact              free context: fold older turns into the session summary
/rag [status|index|search <q>|clear]   the code index
/permission [auto|manual|readonly]     who approves tool calls
/queue [edit <n>|drop <n>|clear]       messages waiting behind the current turn
/runtime [status|stop]  control the local inference runtime
/clear  /exit         clear the screen · leave (frees the model)
```

Type a normal message to send it. Files written or commands run prompt for
approval first — press `a` to always allow, `d` to always deny, or `/exit` to
leave. `/permission auto` approves everything from then on.

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

- The engine is always started with an explicit `--ctx-size` — read from the
  model's own GGUF metadata, not left to a default.
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
the supervisor and is torn down as soon as the last client leaves.

### Skills

Skills are short, focused ways of working — "build a landing page", "review a
diff", "write a migration" — that IMURUN picks for a request automatically and
feeds to the model as part of the prompt. They never clutter the chat; the one in
use appears as a chip in the status line.

IMURUN ships 50+ of them, and can pull a wider community pack:

```bash
imurun skills                 # everything available, with what it's for
imurun skills find "landing page"
imurun skills show build-website
imurun skills sync            # clone a vetted pack from GitHub (license-checked)
```

Synced skills land in `~/.imurun/skills/` as plain markdown with an `origin` and
`license` header, and never shadow a built-in one. Drop your own file in the same
directory — or ask IMURUN to write it — and it is picked up immediately.

### Managing storage

```bash
imurun models                 # what's installed and how much disk it uses
imurun models remove <id>     # delete one model (frees its space)
imurun models remove --all    # delete every model (asks for --yes)
imurun models clean           # show what can be reclaimed
imurun models clean --yes     # free it all (add --engine to drop engine builds)
```

Add `--keep-files` to unregister a model while keeping the GGUF on disk.

## Status

IMURUN is under active construction. Milestones:

- [x] M1 — Workspace, shared schemas, utilities
- [x] M2 — Core config + storage + sessions
- [x] M3 — Providers + agent loop + core tools
- [x] M4 — Runtime daemon (local inference)
- [x] M5 — Model manager (hardware detection, one-click install)
- [x] M6 — Terminal UI (chat, streamed tools, slash commands, agents)
- [x] M7 — Memory (vault, style learning, cross-session)
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
files — it never touches the network or the registry. `bun run package` prints
the exact `npm install -g` line for the staged build. The published version
comes from `packages/cli/package.json`, so a release is a one-line bump.

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
bun run smoke      # M1 verification demo
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

MIT © 2026 ImuTechz
