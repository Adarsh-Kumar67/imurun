# The TUI

**What this covers:** the interactive interface you get from `imurun` — how the
screen is laid out, what the side panel shows, how you type and scroll, the
full keyboard and mouse reference, how work is queued behind a running turn, the
completion popups, and how the agent's context is managed while you watch.

## Opening it

```bash
imurun          # no arguments, with a terminal attached
imurun chat     # the same thing, explicitly
```

If input or output is piped, the bare `imurun` does not open the UI; it prints a
short usage summary instead. Use `imurun run "..."` for scripted, non-interactive
work ([CLI reference](cli-reference.md#imurun-run)).

## The screen

The interface has four parts, and each one is **isolated**: the chat cannot
resize the prompt box, the prompt box cannot resize the panel, and a fast
stream of tokens cannot make anything jump around.

```
┌──────────────────────────────────────────────┬──────────────────────┐
│ ❯ fix the login bug in auth.ts               │  CONTEXT             │
│                                              │  ████████░░░░  24%   │
│   I'll look at auth.ts first.                │  1.6k / 32k tok      │
│   ⠿ read src/auth.ts · tracing the call path │                      │
│   ✔ found the null deref on line 14          │  AGENT               │
│                                              │  build               │
│   2 steps · 2235+140 tokens · 41s            │                      │
│                                              │  MODEL               │
│ ╭─ message ───────────────────── esc stops ╮ │  qwen2.5-coder-7b    │
│ │ ❯ _                                      │ │                      │
│ ╰──────────────────── Ln 1, Col 1 ─────────╯ │  PERMISSIONS         │
│  / commands · shift+tab agent · approval …   │  auto                │
│                                              │  DIRECTORY           │
│                                              │  …/ImuTechz/IMU CLI  │
└──────────────────────────────────────────────┴──────────────────────┘
```

- **The title band** is the top line: the `ImuTechz` lockup (with the **I**
  and the **T** in the brand red), the word `IMURUN` and the version on the
  left, the agent badge on the right. Under it a chrome row carries the
  window dots, the active model and the working directory. The chrome row is
  dropped first on narrow terminals, so the name and the agent always stay.
- **The transcript** is the tall left column. Your messages are prefixed with
  a red `❯`, the model's answers stream in below, and each tool call shows as
  a row: an icon, the verb, the target, and the outcome at the far right.
- **The side panel** is the right column. It appears only when the terminal is
  at least 96 columns wide and is 26 columns across; on narrower terminals it is
  hidden and the status line carries the essentials.
- **The prompt box** sits under the transcript. It is **strict**: always the
  same height, from the first frame to the last. A long draft scrolls inside
  it instead of pushing the frame around, and nothing else on screen can
  change its size. Its top border is titled `message`, its bottom border shows
  a live caret position such as `Ln 2, Col 5`.
- **The footer** under the prompt box is a single line of hints, described
  below.

### The thinking block

The model's thinking is collapsed by default and shows **only its label** —
`thinking · 12s — click to expand`. The reasoning itself never appears until
you click the line open, so a fast stream can never push half-thoughts
through the transcript. Click it again to fold it away.

### The model boot card

When a local engine cold-starts, a card appears above the prompt box:

```
╭─ ● starting your model ─────────────────────────╮
│  ⠸  qwen2.5-coder-7b                             │
│     ██████████████░░░░░░  47%  ·  warming the cache │
╰──────────────────────────────────────────────────╯
```

It names the model, fills a bar, and says what stage the load has reached. It
vanishes the moment the runtime answers, and it never appears for a warm
engine — there is nothing to wait for.

### The approve card

When the agent asks before touching something, the question is a card, not a
line on the status bar:

```
╭─ ◆ approve ─────────────────────────────────────╮
│ edit src/auth.ts                                 │
│ IMURUN is asking before it touches anything.     │
│ y approve  ·  n deny  ·  a always  ·  d never    │
╰──────────────────────────────────────────────────╯
```

### What the side panel shows

| Section | Contents |
| --- | --- |
| `CONTEXT` | A usage bar, the percentage, and used/max tokens. Turns red past 85% and yellow past 60%. The max is the model's **real** window — the size a local engine actually loaded, or one the provider publishes. When neither is known it reads `window unknown` rather than a made-up number. Set [`contextWindow`](configuration.md#contextwindow) to supply one. |
| `AGENT` | The active agent id. |
| `MODEL` | The active model reference, plus the reasoning `effort` when one is set and the provider accepts one. |
| `PERMISSIONS` | The approval mode: `auto`, `manual`, or `readonly`. |
| `DIRECTORY` | The working directory (the tail of the path, which is what identifies it). |
| `SESSION` | The short session id. |
| `PLAN` | Progress through `.imurun/PLAN.md`, e.g. `3/7 steps`, when a plan exists. |
| `TODOS` | The current checklist with glyphs, work-in-progress first, then open, then done. Only the first six are shown, with a `+n more` line. |
| `SOURCES` | The files the project index fed into the current turn (path and line), up to five. This is the provenance of an answer: it is how you can tell *why* the model knows something. Cleared between turns, and hidden entirely with `tui.showRagSources: false`. |
| `MEMORY` | How many notes and sessions memory holds, plus the vault's health score (`vault 92`, or `vault 41 — tidy`), when there is anything to show. Hidden with `tui.showMemoryUsage: false`. |
| `SUBAGENTS` | Shown while one or more `task` subagents are running. |
| `QUEUED` | Shown when messages are waiting behind the current turn. |

Todo glyphs are `☐` open, `◐` in progress, `☑` done.

### Themes

`config.tui.theme` picks the palette:

| Name | For |
| --- | --- |
| `imurun-dark` | The default, drawn for a dark terminal: warm ivory text, muted sand accents, a single brick red for the brand, and quiet hairline rules. |
| `imurun-light` | Light terminals: the same page under daylight — ink on warm paper, with the brand red kept as the one loud colour. |
| `none` | No color at all — for logs, pipes, and terminals that mangle escapes. |

An unknown name falls back to `imurun-dark` and says so, rather than leaving the
half-applied colors of the previous theme on screen.

### The footer

When idle, the footer reads:

```
/ commands · shift+tab agent · pgup/pgdn scroll · approval auto-approve · ctrl+c twice to exit
```

The approval word reflects the current mode (`auto-approve`, `read-only`, or
`manual`). While the agent is working the footer becomes a status line: a
spinner, what the agent is doing, a short animated phrase, the elapsed time, and
any subagent, skill chip, or queue indicator, ending with `esc interrupts`.

## Typing

- `Enter` sends the message.
- `Shift+Enter` or `Ctrl+J` inserts a newline inside the draft.
- `Up` / `Down` move the caret within a multi-line draft. On a single-line draft
  they walk your input history; with an empty prompt they scroll the transcript.
- `Tab` completes slash commands and mentions.
- The prompt box has a fixed height. A long draft scrolls inside it, so the
  frame around it never moves.

## Keyboard reference

| Key | Does |
| --- | --- |
| `Enter` | Send the message. |
| `Shift+Enter` / `Ctrl+J` | Newline inside the draft. |
| `Up` / `Down` | Move within the draft, walk history, or scroll when empty. |
| `PgUp` / `PgDn` | Scroll the transcript by eight lines. |
| `Home` / `End` | Jump to the start or the newest line. |
| `Shift+Tab` | Switch agent, cycling through the primary agents. |
| `Tab` | Complete a slash command or mention. |
| `Esc` | Clear the draft when idle; interrupt a running turn when busy; jump back to the live end when reading back; step back inside wizards. |
| `Ctrl+Z` | Take the last queued message back into the prompt. |
| `Ctrl+C` twice | Exit (the second press within 1.5 seconds). |
| mouse wheel | Scroll the transcript. |
| mouse click in the prompt | Place the caret where you clicked. |
| `Shift` + drag | The terminal's own text selection, left alone on purpose. |

## Scrolling and reading back

Scrolling is pinned to the line you are reading: output that arrives while you
are looking back appears below the fold instead of pushing the text you were
reading off the screen. `PgDn`, `End`, or `Esc` returns you to the live end. The
status row doubles as the jump-to-newest affordance while you are scrolled back.

## Copying out of the chat

Selecting with `Shift`+drag (or the terminal's own copy key) always works —
IMURUN leaves the terminal's selection alone. What a terminal cannot do is hand
over a code block that has scrolled away, so [`/copy`](slash-commands.md#copy)
takes the last answer or a numbered code block and puts it on the clipboard,
writing it to a file instead when the machine has no clipboard tool.

## Queueing messages

While the agent is working, anything you type is **queued** and sent the moment
the turn ends. The queue size appears in the footer and side panel. From the
slash commands you can manage it:

```
/queue edit 1     # pull message 1 back into the prompt to rewrite it
/queue drop 1     # discard message 1
/queue clear      # drop the whole queue
```

`Ctrl+Z` is a shortcut for pulling the last queued message back into the prompt.

## Completion

Typing `/` opens the slash-command menu; keep typing to filter, and `Tab` (or
`Enter` on a highlighted item) completes it. The same completion applies to
mentions. `/help` prints the whole command list, and
[Slash commands](slash-commands.md) documents every one.

## The setup wizard inside the UI

If there is no model the machine can use, opening the UI runs the setup wizard.
It asks whether to run models on this machine or online, and `Esc` steps back
through the questions (and, at the first question, skips setup and opens the
model picker instead). The local path reuses your last model, offers your
installed ones, or recommends and installs the best fit; the online path reuses
your last provider or walks you through adding one. See
[Local models](local-models.md) and [Providers](providers.md). You can run it
again at any time with `/setup`.

## Permission prompts

When the mode is `manual` (or a rule says `ask`), a mutating action pauses and
shows a dialog. The choices include allowing once, always allowing (which saves a
rule), always denying, or cancelling. What runs without asking is described in
[Permissions](permissions.md).

## Context, compaction and resumability

Local models have a small window, so IMURUN treats it as a hard budget:

- The engine is always started with an explicit context size, read from the
  model's own metadata rather than left to a default. See [Runtime](runtime.md).
- Everything sent is measured against the window: the system prompt, recalled
  memory, tool arguments, and history. Tool arguments are compacted before they
  are replayed, so a file you wrote ten turns ago does not fill the window today.
- When history no longer fits, the oldest turns are folded into a durable session
  summary that stays in the system prompt. You keep the thread; the model gets
  its room back. If the engine still refuses a request for size, IMURUN compacts
  harder and retries, so you do not see the raw overflow error.
- An answer cut off by the output limit is continued automatically, with an
  instruction not to repeat what was already written.
- `/compact` does this on demand, and the `CONTEXT` bar in the side panel shows
  the effect.

The exact limits are documented in [Tools](tools.md) and
[Configuration](configuration.md#memory-rag-and-web).

## Notices and errors

Short notices (model ready, a setting changed, a warning) are printed into the
transcript prefixed with `·`. Errors are printed in the error colour. If a tool
call failed or the model asked for an unknown tool, the transcript says so rather
than failing silently.
