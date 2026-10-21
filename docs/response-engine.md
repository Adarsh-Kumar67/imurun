# The response engine

**What this covers:** how IMURUN learns the answer style you want from the
conversation itself, what it stores, how that changes the prompt, and how to
see, force, or forget it. It is not a settings screen and it is not a
fine-tune: it is a small, explainable profile that is updated as you talk.

## What it learns

Six dimensions, each from `0` to `1`:

| Dimension | Low | High |
| --- | --- | --- |
| `brevity` | Full treatment. | The shortest answer that works. |
| `depth` | The action only. | The why, the trade-offs, the alternatives. |
| `stepwise` | Prose is fine. | Number the steps for multi-part work. |
| `codeFirst` | Explain, then show. | The command or the diff first. |
| `formality` | Relaxed and direct. | Neutral, professional, no slang. |
| `verification` | Answer from what is known. | Check it — run it, read the file — before saying it. |

Plus **standing instructions** in your own words ("always run the tests before
you say it works"), kept verbatim after redaction.

The profile starts neutral. Nothing is assumed about you before the first turn.

## How it learns

Two halves, both local.

**The counters** run on every turn, in milliseconds, and never call a model:

- A correction after an answer moves the matching dimension. "Shorter" raises
  brevity and lowers depth; "just the command" raises code-first; "step by
  step" raises stepwise; "check it first" raises verification. A correction
  only counts when it follows an answer and is short — "explain the borrow
  checker" is a question, not a complaint about length.
- A standing instruction ("always…", "never…", "from now on…", "prefer…") is
  captured and quoted back in the prompt.
- The length of what you write is a weak prior on how much you want back. It
  drifts; it never jumps.

**The reader** runs in the background every few turns (or sooner after two
corrections). A model is asked to read the last exchanges and return a strict
JSON proposal. It is invisible: no stream, no transcript entry, no notice. It
is advisory: its proposal is blended halfway into the profile, so one strange
reading cannot rewrite months of evidence. Any failure returns nothing and the
counters remain the profile.

The reader never runs on a fresh machine (it waits for four turns), and asking
it explicitly with `/response refine` does not block the prompt.

## What the model is told

When a dimension is strong enough to be worth saying, it becomes one line in a
short section of the system prompt:

```
## How to answer this person
- Be brief. Lead with the answer; keep prose to one to three sentences unless the work itself needs more.
- Put the command, the diff, or the code first; the explanation follows it.
- Check what you claim before you say it - run it, read the file, or say plainly that you did not.
- They asked for this explicitly, and it still stands: always run the tests before you say it works
```

A neutral profile produces no section at all. The directive competes with the
task for the model's attention, so it is capped at about eight lines.

## Seeing and changing it

```
/response          # the dimensions, the evidence, and the exact prompt section
/response refine   # read this conversation now (background, invisible)
/response reset    # back to neutral
```

`/response` is legible on purpose: you should be able to tell why answers are
the length they are, and to wipe it without hunting for a file.

## Where it lives

`~/.imurun/models/response.json`, written atomically. A corrupt or older file
is repaired into a neutral profile rather than failing to start; losing a style
preference is a small loss, but not starting is not.

## Privacy

- The profile is a handful of numbers and short phrases. It is never sent
  anywhere on its own, and there is no telemetry.
- Anything stored is redacted first: values of `NAME=value` are dropped (the
  name is kept), as are `sk-…`, `ghp_…`, `npm_…` and similar token shapes, and
  long opaque blobs. Key *names* are useful ("the NPM_TOKEN is set"); values
  never are.
- The background reader is a normal model call through your configured
  provider, so it follows the same routing as every other call: local by
  default. It runs at temperature 0 with a 400-token cap.

## Related

- What is kept between sessions: [Memory](memory.md).
- The prompt itself: [Agents](agents.md) and [Configuration](configuration.md).
- The panel that shows the context cost: [The TUI](the-tui.md#context-compaction-and-resumability).
