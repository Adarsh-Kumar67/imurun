# Agents

**What this covers:** what an agent is, the four that ship with IMURUN, how to
switch between them, how the `task` tool delegates to subagents, and how to write
your own agent as a markdown or JSON file. Skills, which are a different kind of
reusable instruction, are covered in [Skills](skills.md).

## What an agent is

An agent is a named working mode. It has its own prompt (its role), its own set
of allowed tools, and optionally its own model. Switching agents switches all of
that, so the same request is handled differently by a careful read-only planner
and by the agent that actually edits files.

Each role is written in four parts — who it is, what it does, what it must never
do, and what its answer looks like — so roles stay comparable and it is obvious
when one is missing a constraint.

## The built-in agents

| Agent | Mode | Prompt and tools |
| --- | --- | --- |
| `build` | primary | The default. Reads, writes, edits, and runs commands. Has every tool. |
| `plan` | primary | Read-only architect. Has read, glob, grep, code_search, web_search, web_fetch, screenshot, memory, progress, todo, plan, and task — and has write, edit, and shell disabled. |
| `general` | primary | General-purpose engineering agent with every tool. |
| `explore` | subagent | Fast, read-only scout. Has read, glob, grep, code_search, web_search, and web_fetch. Used by the `task` tool. |

The **primary** agents are the ones you switch between in a session. The
**subagent** is a worker the agent can delegate to; it is not selected directly.
The default agent is `build`.

## Switching agents

- `/agent` opens a picker; `/agent plan` switches directly.
- `/agents` lists the available agents.
- `Shift+Tab` cycles through the primary agents.
- `imurun run "..." --agent plan` runs one task as a named agent (default
  `build`).

The active agent shapes the system prompt and the set of tools the model can see.
If you name an unknown agent, IMURUN lists the valid ids. Switching is instant.

## Subagents and the `task` tool

The agent can delegate a focused sub-task to a subagent through the **`task`**
tool. A subagent runs in its own session with its own context window and returns
a single text report, so the main conversation stays clean and the details do not
crowd out the window.

Because the subagent cannot see the conversation, the `task` tool asks for a
**brief** in structured fields rather than a blob of prose — a small model fills
these in reliably, and each part lands in a predictable place in the child's
prompt:

| Field | Means |
| --- | --- |
| `aim` | What the subagent must achieve (required). |
| `files` | The files, directories, or symbols to look at. |
| `approach` | How far to go — read only, or change X. |
| `rules` | Constraints it must respect. |
| `tools` | Tools it may use. |
| `expect` | Exactly what to return. |

A brief whose aim is missing, or shorter than three words, is rejected with a
message explaining what is needed. Several independent sub-tasks can be sent in
one call with `action=batch`; they run **concurrently** and their reports are
merged. By default a subagent uses the same working mode as the caller, unless
`agent` names a different one.

## Writing your own agent

Drop a markdown (or JSON) file into:

- `~/.imurun/agents/<id>.md` — global, or
- `<project>/.imurun/agents/<id>.md` — project-local, which wins over global.

Markdown files use simple frontmatter; the body is the agent's prompt:

```markdown
---
name: Docs Writer
description: Writes and edits documentation
tools: read, write, edit, grep
mode: primary
model: qwen2.5-coder-14b
disable: shell
---

You write clear, concise documentation and keep it in sync with the code.
```

| Field | Means |
| --- | --- |
| `id` | The agent id (defaults to the file name). |
| `name` | Display name (defaults to the file name). |
| `description` | One line shown in pickers. |
| `tools` | Comma- or space-separated allow-list. Empty means all tools. |
| `disable` | Comma- or space-separated deny-list (`disabled` and `disabled-tools` are accepted too). |
| `mode` | `primary` or `subagent`. |
| `model` | Optional model reference for this agent. |

Agents are resolved in order: built-ins, then global, then project — a later
definition with the same id replaces an earlier one. A `tools` allow-list
restricts the agent to exactly those tools; a `disable` list removes tools from
whatever would otherwise be available. The `plan` agent, for example, allows the
read tools and disables `write`, `edit`, and `shell`.

You do not have to write agents by hand: ask the agent to create one, and it will
write the file into the agents directory and tell you it is ready.

## Next

- Reusable task instructions rather than working modes: [Skills](skills.md).
- The tools an agent can hold: [Tools](tools.md).
