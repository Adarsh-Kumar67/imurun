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

There are six parts:

| Part | What it holds | Where it lives |
| --- | --- | --- |
| Durable notes | Facts, preferences, style observations, secrets (encrypted), and todos you or the agent chose to keep. | `~/.imurun/memory/notes.md` |
| Session digests | An extractive summary of each session. | `~/.imurun/memory/sessions/<id>.md` |
| Progress ledger | Exact key/value state for resuming interrupted work. | `~/.imurun/memory/ledger/<hash>.json` |
| Todos | The live checklist the side panel shows. | `<project>/.imurun/todos.md` |
| Plan | The written goal, approach, and steps. | `<project>/.imurun/PLAN.md` |
| The vault | Typed cards — people, projects, goals, ideas, lessons — that age and strengthen. | `~/.imurun/vault/` |

## Durable notes

Notes are the part of memory that is meant to last. The model writes them with the
`memory` tool (`action=remember`), and you see them in `~/.imurun/memory/notes.md`:

```markdown
- [preference] Prefers pnpm over npm in this repository — tags: tooling
- [fact] The API base URL is configured in src/config.ts
- [todo] Wire the billing webhook before release
```

Each line has the form `- [kind] text — tags: a, b`, and an optional
`— project: <path>` suffix scopes a note to one project. A credential's text is
encrypted (see [Credentials](#credentials)), which is why its line looks like
`- [credential] enc:...`. There are six kinds:

| Kind | Use it for |
| --- | --- |
| `fact` | A lasting project fact. |
| `preference` | How you like to work (style, tooling, conventions). |
| `user_style` | A style observation IMURUN noticed on its own. |
| `credential` | A secret. Encrypted at rest, never put in a prompt. |
| `todo` | Unfinished work worth carrying forward. |
| `note` | Everything else. |

`session_summary` appears in the machine index to name a session digest document;
it is never a note line.

This file is yours: add, edit, or delete lines freely. IMURUN rewrites it whenever
it learns something new, and re-reads it on the next load, so any line you keep is
picked up again automatically. If the machine index (`index.json`) is ever lost or
corrupted, IMURUN rebuilds it by parsing `notes.md`.

Saving a note whose text is already present updates the existing one (kind, tags,
and timestamp) rather than adding a duplicate. The `memory` tool also has
`action=recall` to search notes, `action=forget` to remove a note by id or text
fragment, and `action=todos` to list unfinished work. See
[Tools](tools.md#memory).

### Learning as you talk

You should not have to say "remember this". When a message contains a standing
instruction — *"always use tabs in this repo"*, *"never touch `vendor/`"*, *"I
prefer pnpm"* — IMURUN saves it as a `user_style` note and prints a short
`noted · …` line so you can see it happen (and say if it got it wrong). Personal
details (*"my name is …"*, *"I work at …"*, *"remember that …"*) are saved as
`fact`s, which is the same path the recall in [How recall works](#how-recall-works)
reads from later.

Learning is deliberately narrow: it looks for the patterns above and nothing
else. Ordinary requests ("run the tests", "fix the parser") teach it nothing, and
a long pasted document is skipped entirely rather than mined for rules. Set
`memory.learnStyle` to `false` to turn off `user_style` notes while still keeping
facts.

## Credentials

A secret you ask IMURUN to keep is stored, encrypted, in the same `notes.md` as
everything else — prefixed with `enc:` so the file still makes sense to read:

```markdown
- [credential] enc:v1:… — tags: deploy
```

The key is 32 random bytes in `~/.imurun/key`, created the first time a secret is
saved, readable only by you (`0600`), and never printed, logged, or sent anywhere.
Losing that file means the secrets it protected cannot be recovered — which is why
they are encrypted rather than left in a markdown file in the first place.

Three properties follow, and all three are deliberate:

- **Credentials are never injected into a prompt.** The durable notes that get
  pinned into every turn skip `credential` notes; the model only ever sees a
  secret if it asks for it with `memory action=recall`.
- **Listings mask them.** `/memory` and human-facing output show the credential's
  name, not its value; the tool result is where the value appears.
- **A lost key does not break a run.** An unreadable secret is dropped from the
  result rather than throwing, so a rotated or missing key degrades to "I can't
  read that" instead of a crash.


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
| Facts | Lines marked `NOTE:`, `FACT:`, `IMPORTANT:`, `REMEMBER:` or `CONSTRAINT:`. |
| Key names | Identifiers such as `NPM_TOKEN` or `GITHUB_PAT` — the name only, never the value. |
| Topics | Markdown headings and the identifiers written in backticks. |

Open todos **carry forward**: an unfinished item from the previous digest stays on
the list until a later message marks it done, so nothing silently falls off
between passes. Files, commands, highlights, facts, key names and topics
accumulate across passes for the same reason. The index keeps the newest **200**
digests; older ones are dropped from the index (their markdown files are written
when the digest is saved).

When older turns are folded away to free the window, the digest is rendered back
into the system prompt as a compact section (`digestToPrompt`), so dropping history
is "freeing context", not "forgetting". `/compact` goes further: it writes the
digest first, then deletes the folded messages from the session, and records how
many it stands in for (`folded`). A digest with a non-zero `folded` count is
injected on every later run, because it is now the only record of those turns.
`/memory` shows memory stats and open todos; `/memory <query>` searches it.

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

## The vault — the second brain

Notes are flat: one line each. Some things need shape — a person with an email
and a history, a project with links to the goals it serves, a lesson that should
resurface a month later. Those are **cards**, and cards live in a vault.

```
~/.imurun/vault/
  MEMORY.md        the map of content (regenerated; open it anywhere)
  persona.md       about you, written by you (see below)
  daily/           spare folder for dated notes
  goals/           goal cards
  projects/        project and crm cards
  thoughts/        note, contact, idea, learning, reflection cards
  MOC/             your own maps, if you make them
  .trash/          duplicates moved aside, never deleted
```

Every card is an ordinary markdown file with frontmatter, so you can open the
vault in any editor or in Obsidian and edit it by hand. IMURUN reads it back
without a database and without a model.

```markdown
---
id: card_8f21ab3c
type: project
title: IMURUN release
tier: active
created: 2026-10-20T09:00:00.000Z
accessed: 2026-10-20T09:00:00.000Z
access-count: 4
status: open
tags: [release, cli]
description: Ship the local-first agent.
---

Ship the local-first agent. Tracks [[IMURUN goals]] and [[TUI polish]].
```

| Field | Means |
| --- | --- |
| `type` | `note`, `contact`, `project`, `crm`, `goal`, `idea`, `learning`, or `reflection`. |
| `title` | Unique within its type; the file is named after it. |
| `tier` | Where the card sits in memory's temperature (below). |
| `access-count` | How many times the card has been used. |
| `description` | Taken from the first paragraph unless written by hand. |
| `[[links]]` | Edges to other cards, by title. `[[Title|alias]]` and `[[Title#heading]]` work. |

### Tiers, and why cards get stronger or fade

Cards are not all equally present. The tier decides what the model sees:

| Tier | Reaches the prompt | How a card gets there |
| --- | --- | --- |
| `core` | Always. | Pinned by you, or promoted by repeated use. |
| `active` | While it was used in the last 7 days. | Every new card starts here. |
| `warm` | On search. | A month of disuse. |
| `cold` | On search, ranked lower. | Two months. |
| `archive` | Only at random, rarely. | Three months, and it does not come back by search. |

Two rules move a card:

- **Use promotes it.** Every recall adds one to `access-count`, updates
  `accessed`, and raises the tier one step. A card can only reach `core` after
  eight accesses, so "always in the prompt" is earned rather than awarded once.
- **Disuse demotes it.** A card untouched for 30 days drops a tier, and another
  every 30 days after that. Ageing is computed when the vault is read, so a
  vault left alone for a year reads correctly without anything having run;
  `maintain` writes the aged tier back for outside editors.

Ranking is offline and lexical: how much of the query the card accounts for,
with title and tag hits weighted above a mention in the body, multiplied by
`1 + ln(access-count)` and by the tier weight. No embeddings, no model call.

### Resurfacing

When a turn's question matches no card, IMURUN occasionally picks one cold or
archived card at random and shows it as a one-line chip above the prompt
(`recalled · Garden plan — tomatoes and basil`). It is bounded: at most one card,
never every turn, and never a chat message.

### The persona

`~/.imurun/vault/persona.md` is yours to write. Anything filled in there is put
in front of the model at the start of every session, above anything IMURUN
inferred:

```markdown
# About me

- Name: Shubham
- Timezone: IST
- What I am working on: IMURUN, a local-first coding agent
- How I like answers: short, with the command first
```

The untouched scaffold is ignored, so an empty persona costs nothing.

### Health and tidying

The vault scores itself out of 100: links (40), orphans (25), duplicate titles
(20), and whether `MEMORY.md` exists (15). `/memory vault` shows the score, the
cards in the prompt, and the broken links; `/memory vault tidy` repairs links
that have one plausible target, moves duplicates to `.trash/` (keeping the
most-used copy), writes aged tiers back, and regenerates `MEMORY.md`. Orphans
are reported, never deleted — a card nobody links to can still be the only copy
of something true.

The side panel shows the score beside the note count and says `— tidy` when it
falls below 80.

The design is a clean-room port of `smixs/agent-second-brain` (MIT):
[Third-party notices](../THIRD_PARTY_NOTICES.md).

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

- the most relevant recalled memories (notes + digests, or notes alone when
  `memory.crossSession` is off),
- the **durable notes** worth pinning — everything but `note` and `credential`
  entries, project-scoped plus global, newest first, up to 8,
- the project material the index considered relevant, when `rag.autoInject` is on,
- the open todos (project todos plus up to 10 carried forward from memory),
- the open progress-ledger entries (up to 12),
- the written plan, if `.imurun/PLAN.md` exists,
- the `core` and recently used `active` cards from the vault, and the persona
  file when you have filled it in.

Once the conversation is compacted, todos and the plan are left out of the prompt
and replaced by the compact digest, so the same information is not sent twice.

## Configuration

The `memory` section of `imurun.json` controls it (see
[Configuration](configuration.md#memory)):

```jsonc
{
  "memory": {
    "enabled": true,
    "learnStyle": true,
    "crossSession": true,
    "autoSummarize": true,
    "maxRecallEntries": 5,
    "vault": true,
    "vaultPath": "~/Documents/second-brain"
  }
}
```

`enabled` is the master switch; `autoSummarize` controls writing session digests;
`maxRecallEntries` sets how many recalled entries a turn includes;
`learnStyle` turns the automatic `user_style` notes on or off (facts are always
kept when you state them); and `crossSession` decides whether session digests take
part in recall. With `crossSession: false`, a turn searches only your own notes —
nothing from past sessions — which is the setting for a shared or audited machine.

`vault` turns the card vault on or off; `vaultPath` points it at your own
Obsidian vault instead of `~/.imurun/vault`. Both are optional.

## Managing memory

| Command | Effect |
| --- | --- |
| `/memory` | Show the store path, note counts by kind, session count, and open todos. |
| `/memory <query>` | Search notes and digests (up to 8 hits). |
| `/memory vault` | Vault health, the cards in the prompt, and the persona status. |
| `/memory vault tidy` | Repair links, quarantine duplicates, write aged tiers, rewrite `MEMORY.md`. |
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

~/.imurun/
  key                   machine key for encrypted credentials (0600)
  vault/                the second brain (see above)
    MEMORY.md           the map of content
    persona.md          about you, written by you
    thoughts/ goals/ projects/ daily/ MOC/ .trash/

<project>/.imurun/
  todos.md              the live checklist
  PLAN.md               the written plan
  web-cache/            pages web_fetch cached, when web.cacheFetches is on
```
