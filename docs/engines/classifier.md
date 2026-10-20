# The classifier

Every engine in IMURUN is built on one small piece of machinery: a bounded
linear classifier with a persisted state file. This page describes it once,
because the other pages only have to say what they feed it.

Source: `packages/core/src/engines/linear.ts`.

## What it does

Given a **feature vector** — a list of `(name, value)` pairs — it returns a
probability between 0 and 1:

```
score    = Σ weight(feature) × value(feature)
prob     = 1 / (1 + e^−score)
```

The features are the engine's own: word unigrams and bigrams with a prefix
(`w:node`, `w:node version`), shape markers (`shape:question`,
`shape:year`, `len:long`), and a `bias` feature the caller includes so the
intercept can differ per use.

## Learning

One gradient step toward a label:

```
gradient = target − current probability
weight  += rate × value × gradient
```

with a small decay per update (so stale evidence fades), a learning rate, and
a hard clamp on how large any single weight may become.

**The bias is a feature, not a constant.** It is listed in the feature vector
like anything else, so a caller can give the same model a different intercept
for a different use without training a second model.

## Priors

Every engine starts with a table of weights. Those are *starting numbers*:
they make a cold install behave sensibly, and they are written down in the
engine's source where they can be read and argued about. A learned weight
replaces the prior for the same feature name.

```ts
const PRIORS: Record<string, number> = {
  bias: -1.5,
  "shape:year": 0.8,
  "w:latest": 1.4,
  // …
}
```

## The state file

```json
{ "version": 1, "trained": 42, "weights": { "bias": -1.2, "w:latest": 1.51 } }
```

- **One file per engine.** The engine owns its path; nothing else writes it.
- **Atomic.** The state is written to a temporary file and renamed into place,
  so an interrupted write can never leave a half-written model behind.
- **Versioned.** A file whose `version` does not match is ignored, which is
  what makes a format change safe: old files are replaced by priors, not
  misread.
- **Bounded.** The vocabulary is capped (20,000 features by default). When it
  is full, the weakest weights are dropped — but never a prior, so a cold
  start always keeps its documented behaviour.

## What happens when the file is bad

| The file is… | What happens |
| --- | --- |
| missing | the priors are used |
| not valid JSON | the priors are used |
| from another version | the priors are used |
| has a non-finite or absurd weight | the priors are used |
| empty | the priors are used |

None of these is an error the user sees: an engine that cannot read its state
still works, it just starts again from the documented behaviour.

## Resetting

Delete the engine's state file. The next request rebuilds it from the priors.
