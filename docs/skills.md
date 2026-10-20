# Skills

**What this covers:** what a skill is, the built-in library that ships with
IMURUN, how the router scores and injects the right one automatically, how to
browse and use skills from the CLI and the interface, how to add your own, and
how to import a published skill pack. Working modes are covered separately in
[Agents](agents.md).

## What a skill is

A skill is a short, focused way of working — "build a landing page", "review a
diff", "write a migration" — that IMURUN can pick for a request automatically
and feed to the model as part of the prompt. Skills never clutter the chat: the
one in use appears as a chip in the status line.

A skill is a name, a description, loose tags, and a body of instructions. That is
all it is; there is no runtime, no code, no network. IMURUN ships **53 built-in
skills** covering web and frontend work, APIs and services, data, testing and
review, reliability, shipping, documentation, and product and design tasks
(including UX copy, CLI tools, automation scripts, and security review).

## How a skill gets chosen

You do not have to remember commands. The router scores every available skill
against what you actually asked, and injects the best match when it is confident:

- Name and id match: **+3** per term.
- Tag and "when to use" match: **+2**.
- Description match: **+1.5**.
- Body match: **+0.5** (used only if the description did not match).
- The total is divided by the square root of the number of terms, so a long
  request does not out-score a short one merely for having more words.

A skill is considered relevant at a score of **3.0 or above**. If nothing clears
that, no skill is injected — a wrong skill is worse than none, because it steers
the model into a method you did not ask for. When a skill is active you can see
its name in the status line while the turn runs.

## Using skills from the CLI

```
imurun skills                       # everything available, by source
imurun skills show <id>             # print one skill's instructions
imurun skills find <query>          # what the router would pick
imurun skills sync [owner/repo]     # import a published pack
imurun skills dir                   # where skills are read from
```

- `imurun skills` groups skills by source — built-in, imported
  (`~/.imurun/skills`), and project (`.imurun/skills`) — with a total count.
- `imurun skills find "add a dark mode toggle"` shows the ranked matches with
  scores. A filled dot (`●`) marks a score at or above 3.0 (the point at which
  the router injects automatically); a hollow dot (`○`) is shown for context.
- `imurun skills show build-website` prints the skill's instructions. A bare
  `imurun skills <id>` is shorthand for `show`.

`find` accepts `--limit` (default 8) and `list` accepts `--all` to print every
description. `--json` gives machine-readable output.

## Using skills from the interface

```
/skills              # pick a skill to load into the input
/skills <id>         # load that skill
/skills sync         # import a pack
```

## Where skills live

Skills are resolved in this order, and a later definition with the same id
replaces an earlier one:

1. **Built-in** — shipped with IMURUN.
2. **Global** — `~/.imurun/skills/<id>.md`, or a folder `<id>/SKILL.md` (the form
   published by skill packs).
3. **Project** — `<project>/.imurun/skills/<id>.md`, which wins over global.

A skill file is plain markdown with minimal frontmatter:

```markdown
---
name: Build a website
description: Plan and build a complete website from a description
tags: web, frontend
---

...instructions...
```

You can drop a file in the same directory yourself, or ask the agent to write
one — it will put the file in the skills directory shown in its environment
section and tell you it is ready. There is also a set of well-known aliases so
common names resolve to the right skill:

| Alias | Resolves to |
| --- | --- |
| `code_review`, `code-review` | `review` |
| `tests`, `testing` | `unit-tests` |
| `website`, `web`, `frontend` | `build-website` |
| `documentation` | `docs` |
| `onboarding_guide` | `onboarding` |

## Importing a skill pack

A skill pack is any public GitHub repository laid out with one folder per skill,
each containing a `SKILL.md` with `name` and `description` frontmatter. The
default source is the public `anthropics/skills` repository.

```bash
imurun skills sync                                  # from the default source
imurun skills sync owner/repo
imurun skills sync owner/repo --branch main
imurun skills presets                               # the packs IMURUN knows by name
imurun skills sync second-brain                     # a preset, one command
```

Two rules keep sync safe and predictable:

1. **Nothing silently replaces a built-in.** If an imported skill clashes with a
   built-in id, it is imported under `<owner>-<name>` instead, and the sync
   reports the rename.
2. **Source-available skills are skipped** unless you explicitly opt in with
   `--include-restricted`. IMURUN ships only free, open licences by default. The
   known restricted packs are `docx`, `pdf`, `pptx`, and `xlsx`.

Imported skills are written to `~/.imurun/skills/` as plain markdown, recording
their `origin` (a repository URL) and `license`. Re-running a sync updates skills
in place. A few well-known pack skills are given friendlier IMURUN ids (for
example `skill-creator` becomes `create-skill`, `canvas-design` becomes
`canvas-graphics`).

### Presets

A preset is a pack with a known purpose, so `sync <id>` is enough:

| Preset | Source | What it adds |
| --- | --- | --- |
| `anthropic` | `anthropics/skills` | The general-purpose collection (the default). |
| `second-brain` | `smixs/agent-second-brain` | Capture, review and resurface what was learned — the skills that go with the memory vault. |

A preset can exclude skills that do not apply to IMURUN, and the exclusion is
reported rather than silent. For `second-brain`, `migrate-doctor` (an upgrade
doctor for that project's own storage) and `dbrain-processor` (which expects its
data layout) are skipped. Everything imported records the pack's licence — MIT,
for that pack. See [Third-party notices](../THIRD_PARTY_NOTICES.md).

A sync imports each skill's `SKILL.md` — its instructions — and nothing else.
Scripts, references and templates that live beside it stay in the repository, so
a skill whose instructions call a bundled script is imported as guidance only.
The pack's own tooling is never installed or run.

## Note on the skill count

The built-in catalog contains **53** skills, as measured by the catalog array in
`packages/core/src/agent/skill-catalog.ts`. A header comment in that file and a
comment in `packages/core/src/agent/skills.ts` still say "50"; those comments are
stale and the code is authoritative.

## Next

- Working modes instead of task instructions: [Agents](agents.md).
- How skills and memory fit into the system prompt:
  [The TUI](the-tui.md#context-compaction-and-resumability).
