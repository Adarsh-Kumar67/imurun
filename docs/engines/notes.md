# The note engine

Source: `packages/core/src/memory/note-engine.ts` (what to keep),
`packages/core/src/memory/retention.ts` (how long it lasts),
`packages/core/src/memory/learn.ts` (the wiring).

A standing instruction arrives as an ordinary sentence: *"always use tabs in
this repo"*, *"my name is Shubham"*, *"remember that deploys run on
Fridays"*. Waiting for the model to notice and call the memory tool means
those are lost whenever it does not.

So the decision is made here, by an engine, before the model is involved.

## What it does

### 1. Find the candidates

A message is split into clauses. A clause is a candidate if it is long
enough to mean something and short enough to be a rule — a pasted document is
skipped entirely.

### 2. Is it durable?

Each clause is scored by a classifier over its words and its shape: is it
first-person, does it read like an explicit request to remember, does it
carry something that looks like a secret, is it scoped to this repository.
Above the threshold, it is a note.

Three more classifiers then say **what kind** it is:

| Kind | Example |
| --- | --- |
| `user_style` | "always use tabs in this repo" |
| `fact` | "my name is Shubham" |
| `credential` | "my deploy token is ghp_…" |
| `note` | anything else that is durable |

### 3. Merge what is said twice

A candidate is compared against the notes that already exist by meaning, not
by substring. A near-duplicate is merged into the existing note (and the
existing note is kept when the new wording says less). Something unrelated is
never merged.

### 4. Learn from the explicit ones

When the user said *"remember that …"* in so many words, that is a clear
label: the clause is durable, and of the kind it turned out to be. It is fed
back into the classifiers, so the engine gets better at reading this user in
particular.

## Retention — how long a note stays worth keeping

Retention is **data**, not a chain of `if (kind === …)`. Every kind declares
a half-life, every use makes a note stronger, and the two combine:

```
decay    = 0.5 ^ (age in days / half-life)
strength = 1 + ln(1 + uses)
score    = decay × strength
```

| Kind | Half-life |
| --- | --- |
| `credential` | 10 years |
| `fact` | 3 years |
| `preference` | 2 years |
| `user_style` | 1 year |
| `note` | 120 days |
| `session_summary` | 90 days |
| `todo` | 30 days |

The score orders the durable notes and decides which ones fall outside the
prompt limit. A credential you use daily outranks a style note you touched
once; a todo that has been open for a year has faded on its own.

Using a note raises its `usageCount`, which promotes it — the same note
asked for twice is worth more than one asked for once.

## State

`~/.imurun/models/note.json` — the durable classifier, plus one classifier
per kind:

```json
{
  "version": 1,
  "durable": { "version": 1, "trained": 12, "weights": { … } },
  "kinds": { "user_style": { … }, "fact": { … }, "credential": { … } }
}
```

The format, the atomic write, the version field and the corrupt-file
behaviour are described in [the classifier page](classifier.md).

**The notes themselves are not in this file.** They live in the memory store
(`~/.imurun/memory/notes.md`, with credentials encrypted at rest), so
deleting the model file does not delete anything the user asked to keep — it
only makes the engine forget how it learned.

## Resetting

```bash
rm ~/.imurun/models/note.json
```

The engine starts from its priors again; the notes stay where they are. To
turn off learning of style rules while keeping facts and credentials, set
`memory.learnStyle` to `false` in `imurun.json`.
