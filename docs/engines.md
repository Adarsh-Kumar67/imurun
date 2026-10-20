# Engines

IMURUN makes several decisions on its own: whether a question needs the
internet, whether a sentence is worth keeping, which skill should be applied,
what should be remembered and for how long. None of them is a list of trigger
words any more.

Each one is an **engine**: a small learned classifier with a state file it
writes, a learning rule it follows, and a documented way to reset it. This
page is the index; each engine has its own page with the details.

| Engine | Decides | State file | Page |
| --- | --- | --- | --- |
| [The classifier](engines/classifier.md) | the shared machinery every engine is built on | — | [engines/classifier.md](engines/classifier.md) |
| [Research](engines/research.md) | does this request need the internet, and is the answer supported | `~/.imurun/models/research-need.json` | [engines/research.md](engines/research.md) |
| [Notes](engines/notes.md) | is this sentence worth keeping, what kind is it, how long does it last | `~/.imurun/models/note.json` | [engines/notes.md](engines/notes.md) |
| [Skills](engines/skills.md) | which method should be applied to this request | `~/.imurun/models/skills.json` | [engines/skills.md](engines/skills.md) |

## The rule behind all of them

**No keyword gates.** A decision may depend on the *shape* of the input (a
question mark, a year, a file path, the number of words) and on words that
have been *learned* to matter. What it may not do is check a hand-written
list of phrases and act on a match.

**Cold-start priors are documented numbers, not gates.** Every engine starts
with a table of weights. They exist so a fresh install behaves sensibly on the
first request, and they are written down in the source where they can be read
and argued with. A learned weight replaces a prior for the same feature; a
feature nobody wrote a prior for still counts once it has been seen against a
label.

**Every engine has one state file.** It is written atomically (a temporary
file, then a rename), carries a version number, and a file that is missing,
corrupt, or from another version falls back to the priors instead of
crashing. Every one of those paths has a test.

**Learning comes from outcomes, not guesses.** A label is a fact about what
happened: the turn failed, the answer was checked, the skill was applied and
the work went well. Not "this looks like a research question".

## Checking what an engine knows

Each engine can explain its current decision — the features that contributed,
with their weights. In the TUI, the research step says why it searched:

```
researched 3 sources · what is the current node.js version
```

and the research engine's own explanation lists the features that pushed the
decision, which is the same information the engine uses internally.

## Starting over

Every engine's state is a single file. Deleting it puts the engine back to
its documented priors:

```bash
rm ~/.imurun/models/research-need.json   # research: back to the priors
rm ~/.imurun/models/note.json             # notes: back to the priors
rm ~/.imurun/models/skills.json           # skills: back to the priors
```

Nothing else has to be cleaned up: the engines hold no other state, and the
notes themselves live in the memory store, not in the model's state file.
