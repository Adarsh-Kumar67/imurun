# The research engine

Source: `packages/core/src/research/need.ts` (the decision),
`packages/core/src/research/engine.ts` (the search and the checking).

A local model does not know what happened after its training cut-off, and a
small one will often answer a current-events question from memory even when
it has a `web_search` tool. Telling it to "always search" wastes time on
"rename this function"; telling it to "search when needed" gets ignored.

So the decision is taken out of the model's hands, at the point where it
matters.

## The three stages

### 1. Before the first token — does this need the internet?

The **need engine** reads the request and returns a probability. Its features
are the request's words plus its shape: a question mark, a year, a number, a
URL, a file path, a stack trace, a first-person framing, and how much of the
project is already in the prompt.

Above `0.5`, IMURUN searches. Below it, it does not.

The setting `web.research` in `imurun.json` overrides the engine:

| Setting | Behaviour |
| --- | --- |
| `"auto"` (default) | the engine decides |
| `"always"` | always search first, whatever the engine thinks |
| `"off"` | never search automatically — the `web_search` tool stays available |

### 2. The search — gather, don't guess

The search runs through a **backend chain**: the configured backend first
(DuckDuckGo by default — no key needed), then whatever else can work
(SearXNG, Brave). A backend that fails or returns nothing moves on to the
next, and if none work the turn carries on *without* evidence rather than
hanging or pretending.

The results are then:

- **deduplicated** by canonical URL and by title similarity;
- **ranked** by how much of the query each result actually covers, with a
  small bonus for a year in the text and for `https`;
- **limited** to at most two pages per domain, so one site cannot fill the
  evidence;
- **read**: the page is fetched, its text extracted, and the paragraphs that
  contain the query's terms are kept (at most two per page).

What reaches the prompt is a numbered list of sources and the matching
passages, so a claim in the answer can be traced to a page.

### 3. After the draft — is the answer supported?

The answer is checked against the evidence that was gathered:

- every factual sentence is extracted (numbers, capitalised names, no
  questions, no code blocks);
- a number that appears **nowhere** in the evidence fails the claim on its
  own — versions, dates and prices are what models get wrong;
- otherwise the claim must share enough with the evidence to be supported;
- a citation `[7]` with no source 7 fails too.

If a claim fails, **one** follow-up search is run, built from the claim
itself, and the model is asked to reconcile the answer against the new
evidence — remove it, qualify it, or cite what was actually found. The budget
is one verification per turn.

## Learning

| What happened | Label |
| --- | --- |
| the model called `web_search` itself | needed |
| the engine searched and found sources | needed |
| the turn ended with no search and no need for one | not needed |

The model searching on its own is the strongest signal there is: the model
knew it needed the internet. That label is fed back whether or not the engine
had already searched.

## State

`~/.imurun/models/research-need.json` — the need classifier's weights. The
format, the atomic write, the version field and the corrupt-file behaviour
are all described in [the classifier page](classifier.md).

The search itself keeps no state: the evidence lives in the prompt for that
turn, and the answers live in the session.

## Resetting

```bash
rm ~/.imurun/models/research-need.json
```

The next question starts from the documented priors again. To stop researching
entirely, set `web.research` to `"off"` in `imurun.json`.
