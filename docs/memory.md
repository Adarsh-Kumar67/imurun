# Memory

**What this covers:** everything IMURUN remembers between and across sessions —
the durable notes you can read and edit, the automatic session digests, the
per-project progress ledger, and the todo and plan files. It explains where each
piece lives, what gets put back in front of the model, and how recall works
without a network or a model call.

## The problem memory solves

A local model has a small context window and no durable state of its own. When a
run is interrupted, when the window fills up and older turns are dropped, or when
you start a fresh session the next day, the model has no way to know what already
happened. Memory is the fix: IMURUN keeps the important facts outside the window,
on disk, and puts the relevant ones back when they matter.

All of it is offline, local, and free of telemetry. Nothing is sent anywhere, and
every piece is a plain file you can read, edit, diff, and delete.

There are five parts:

| Part | What it holds | Where it lives |
| --- | --- | --- |
| Durable notes | Facts, preferences, decisions, and todos you or the agent chose to keep. | `~/.imurun/memory/notes.md` |
| Session digests | An extractive summary of each session. | `~/.imurun/memory/sessions/<id>.md` |
| Progress ledger | Exact key/value state for resuming interrupted work. | `~/.imurun/memory/ledger/<hash>.json` |
| Todos | The live checklist the side panel shows. | `<project>/.imurun/todos.md` |
| Plan | The written goal, approach, and steps. | `<project>/.imurun/PLAN.md` |

## Durable notes

Notes are the part of memory that is meant to last. The model writes them with the
`memory` tool (`action=remember`), and you see them in `~/.imurun/memory/notes.md`:

```markdown
- [preference] Prefers pnpm over npm in this repository — tags: tooling
- [fact] The API base URL is configured in src/config.ts
- [todo] Wire the billing webhook before release
```

Each line has the form `- [kind] text — tags: a, b`, and an optional
`— project: <path>` suffix scopes a note to one project. There are four kinds:

| Kind | Use it for |
| --- | --- |
| `fact` | A lasting project fact. |
| `preference` | How you like to work (style, tooling, conventions). |
| `todo` | Unfinished work worth carrying forward. |
| `note` | Everything else. |

This file is yours: add, edit, or delete lines freely. IMURUN rewrites it whenever
it learns something new, and re-reads it on the next load, so any line you keep is
picked up again automatically. If the machine index (`index.json`) is ever lost or
corrupted, IMURUN rebuilds it by parsing `notes.md`.

Saving a note whose text is already present updates the existing one (kind, tags,
and timestamp) rather than adding a duplicate. The `memory` tool also has
`action=recall` to search notes, `action=forget` to remove a note by id or text
fragment, and `action=todos` to list unfinished work. See
[Tools](tools.md#memory).

## Session digests

When a session is compacted (the window is full), when you run `/compact`, and
when a session closes, IMURUN writes a **digest** of that session to
`~/.imurun/memory/sessions/<id>.md` and records it in the index.

Digests are deliberately extractive and deterministic: they run offline, in
constant time, with no model call, so they can be produced while you are still
typing and never fail when no model is available. A digest collects:

| Section | Where it comes from |
| --- | --- |
| Files touched | File arguments of tool calls. |
| Commands | Commands run through `shell`. |
| Open todos | Recognised todo lines and carried-forward ones. |
| Completed | Recognised done lines. |
| Highlights | The first line of notable assistant messages. |

Open todos **carry forward**: an unfinished item from the previous digest stays on
the list until a later message marks it done, so nothing silently falls off
between passes. The index keeps the newest **200** digests; older ones are dropped
from the index (their markdown files are written when the digest is saved).

When older turns are folded away to free the window, the digest is rendered back
into the system prompt as a compact section (`digestToPrompt`), so dropping history
is "freeing context", not "forgetting". `/memory` shows memory stats and open
todos; `/memory <query>` searches it.

## The progress ledger

The ledger is the exact-state half of memory, and it is what makes a run
resumable. A digest is searchable text; the ledger is state that has to be recalled
verbatim — for example `file:src/app.ts` was appended to, 12 KB, section 3 done.

It is a small key/value store per project:

| Property | Value |
| --- | --- |
| Keys | Short and stable, e.g. `file:src/app.ts`, `task:landing-page`, `step:3`. |
| Values | One line describing the state. |
| Status | `open` (still in flight) or `done` (finished). |
| Entries kept | 200 per project; the newest are kept when the cap is hit. |
| Surfaced to the model | Up to 12 open entries, newest first. |

The `progress` tool reads and writes it (`list`, `set`, `remove`, `clear`), and it
lives at `~/.imurun/memory/ledger/<hash>.json` where `<hash>` is derived from the
project path. Writes are atomic and the file is plain JSON, so a crash mid-write
cannot leave a half-parsed ledger behind. Writing a file through the `write` or
`edit` tool records it in the ledger automatically, without clobbering a deliberate
`done` marker the model may have set.

## Todos and the plan

Todos and the plan live **in the project**, not in `~/.imurun`, because they are
part of the work rather than part of the agent's private state. Both are plain
markdown, both diff in git, and both survive a wiped home directory.

`.imurun/todos.md` is the checklist:

```markdown
# Todos

- [x] read the parser
- [/] write the tests
- [ ] publish 0.1.0
```

`[ ]` is open, `[/]` in progress, `[x]` done (the Obsidian Tasks convention). An
indented line under a step is its detail. The list holds up to **100** items, and
up to **20** unfinished ones are included in the system prompt.

`.imurun/PLAN.md` records what the task *is* — the goal, the approach, and the
ordered steps with the files each touches. Up to **15** steps are included in the
prompt. For anything bigger than a couple of steps the model is told to write the
plan first and keep it current. See [Tools](tools.md#todo) and
[Tools](tools.md#plan).

## How recall works

Recall is offline and dependency-free. It is a small BM25 ranking over the notes
and session digests, run entirely in-process, which is why it works on a fresh
machine with nothing loaded.

- The query and each document are tokenized to lowercase words of two or more
  characters, minus a built-in stopword list.
- BM25 is used with `k1 = 1.2` and `b = 0.75`.
- A document whose kind starts with `todo`, `preference`, or `session_summary`
  gets a ×1.15 boost.
- A document from the active project gets a ×1.25 boost.
- With an empty query, recall degrades to "most recent first", so it never comes
  back empty-handed.
- Hits are rendered one line each, clipped to 240 characters.

The `memory` tool's `recall` action returns up to 8 hits; the run itself recalls
`maxRecallEntries` (default 5) relevant entries when a turn starts.

## What goes into the prompt

At the start of a turn IMURUN gathers, all offline:

- the most relevant recalled memories (notes + digests),
- the **durable notes** worth pinning — non-`note` entries, project-scoped plus
  global, newest first, up to 8,
- the open todos (project todos plus up to 10 carried forward from memory),
- the open progress-ledger entries (up to 12),
- the written plan, if `.imurun/PLAN.md` exists.

Once the conversation is compacted, todos and the plan are left out of the prompt
and replaced by the compact digest, so the same information is not sent twice.

## Configuration

The `memory` section of `imurun.json` controls it (see
[Configuration](configuration.md#memory)):

```jsonc
{
  "memory": {
    "enabled": true,
    "autoSummarize": true,
    "maxRecallEntries": 5
  }
}
```

`enabled` is the master switch; `autoSummarize` controls writing session digests;
`maxRecallEntries` sets how many recalled entries a turn includes. The section
also declares `learnStyle` and `crossSession`, which exist on the configuration
surface.

## Managing memory

| Command | Effect |
| --- | --- |
| `/memory` | Show the store path, note counts by kind, session count, and open todos. |
| `/memory <query>` | Search notes and digests (up to 8 hits). |
| `/compact` | Fold older turns into the session summary now and free context. |
| `/plan` | Show the written plan and update it. |
| `/todo` | Show or edit the checklist. |

The `imurun sessions` command lists and manages sessions (see
[CLI reference](cli-reference.md#sessions)).

## Where files live

```text
~/.imurun/memory/
  notes.md              durable notes (human-readable and editable)
  index.json            machine index of notes and digests
  sessions/<id>.md       one digest per session
  ledger/<hash>.json     one progress ledger per project

<project>/.imurun/
  todos.md              the live checklist
  PLAN.md               the written plan
```
