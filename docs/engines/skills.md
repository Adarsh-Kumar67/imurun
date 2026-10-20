# The skill router

Source: `packages/core/src/agent/skill-router.ts`,
`packages/core/src/agent/skills.ts`.

A skill is a way of working: "build a website", "write a migration", "audit
accessibility". The agent applies one automatically when it fits, so the user
does not have to remember a command.

The first version scored every skill by counting how many of the request's
words appeared in the skill's name, tags, description and body. It worked,
but it never improved: the same request always got the same skill, even
after that skill had proved useless.

## How it works now

**Finding the candidates.** The overlap score is still the first filter: a
skill nobody's words appear in is not a candidate. This is the cold-start
signal, and it is also what makes a request with nothing in common select
nothing at all.

**Ranking them.** Each skill has its own small classifier over the request's
features, plus the overlap score itself. The learned model has the last
word, so a skill that has repeatedly led to failure can be passed over even
when the words match — and a skill that has repeatedly helped is preferred
over a fresher-looking one.

## Learning

The label comes from what the turn actually did:

| What happened | Label |
| --- | --- |
| the turn produced an answer and no tool call failed | the skill helped |
| the turn ended in tool failures, or in no answer at all | the skill did not help |

The applied skill is labelled at the end of every turn that used one. A skill
that keeps leading to failures is down-weighted; one that keeps helping is
up-weighted. Nothing else is guessed.

## State

`~/.imurun/models/skills.json`:

```json
{
  "version": 1,
  "models": { "seo": { "version": 1, "trained": 5, "weights": { … } } },
  "applied": { "seo": { "used": 5, "helped": 4 } }
}
```

The format, the atomic write, the version field and the corrupt-file
behaviour are described in [the classifier page](classifier.md).

## Resetting

```bash
rm ~/.imurun/models/skills.json
```

The router goes back to the plain overlap score, and the skills themselves
are untouched — they live in `~/.imurun/skills/` and in the project.

To switch a skill off without deleting it, remove its file, or pick it
manually with `/skills`.
