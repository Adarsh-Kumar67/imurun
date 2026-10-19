# Permissions

**What this covers:** how IMURUN decides whether a tool call may run. It explains
the three approval modes, the exact order the decision is made in, the built-in
allow and ask lists, the rules you can write, and what happens when there is no
one to ask. It is the reference behind the `permissions` config section and the
`/permission` command.

## The short version

A fresh install runs in **auto** mode: every tool runs without a prompt, because a
local agent whose whole point is to get work done should not stop on every call.
When you want more control, `/permission manual` makes IMURUN ask before anything
that changes the machine, and `/permission readonly` lets it look but never touch.

## Approval modes

| Mode | What it does |
| --- | --- |
| `auto` | Run every tool without asking (the default). The fastest way to work. |
| `manual` | Ask before a tool that changes the machine; allow read-only tools silently. |
| `readonly` | Allow inspection only; refuse anything that mutates. |

The mode is set from three places, in order of precedence for a running session:

- `/permission [auto|manual|readonly]` changes it for the current session. With no
  argument it opens a picker (`Auto-approve`, `Manual`, `Read-only`) showing which
  one is active.
- The `permissions.mode` field in `imurun.json` sets the starting mode.
- `auto` is the default when nothing else is set.

The active mode is shown in the footer as `approval <mode>`, and switching to
`auto` prints a warning notice, because it means nothing will be confirmed again.

## The decision order

Every tool call goes through the same sequence. The first step that produces an
answer wins:

1. **Disabled tool** — if the tool is in `disabledTools`, the call is **denied**.
2. **Auto mode** — if the mode is `auto`, the call is **allowed**.
3. **Read-only mode** — if the mode is `readonly` and the tool is in the mutating
   list, the call is **denied**.
4. **Rules** — the configured rules and the saved rules are checked in order, and
   the first one that matches decides: **allow**, **ask**, or **deny**.
5. **Read-only fallback** — if the mode is `readonly` (and the tool is not
   mutating), the call is **allowed**.
6. **Auto-allow list** — if the tool is in the auto-allow list, the call is
   **allowed**.
7. **Otherwise** — the call **asks**.

Because the user's mode wins over the rules for rejecting tools, `readonly` cannot
be overridden by an allow rule for a mutating tool — that is the point of the mode.

## Built-in tool lists

The lists are fixed; they are not configurable.

| List | Tools |
| --- | --- |
| Auto-allow (read-only) | `read`, `glob`, `grep`, `code_search`, `memory`, `progress`, `todo`, `plan`, `web_search`, `web_fetch` |
| Always ask / mutating | `shell`, `write`, `edit`, `screenshot` |

So in `manual` mode the read-only tools run silently and the mutating ones ask. In
`readonly` mode the mutating ones are refused outright. A tool that is on neither
list (for example `task`) is allowed silently in `readonly` and asks in `manual`.

See [Tools](tools.md) for what each tool does.

## Rules

A rule says what to do when a particular tool is called with a particular detail.
Rules are written in the `permissions.rules` array and are also created on the fly
when you choose "always allow" or "deny always" at a prompt.

| Field | Type | Meaning |
| --- | --- | --- |
| `tool` | string | A tool name, or `*` to match every tool. |
| `pattern` | string | Optional. What to match against the call's detail (see below). |
| `action` | `allow` \| `ask` \| `deny` | What to do when the rule matches. |
| `source` | `config` \| `saved` \| `session` | Where the rule came from (default `config`). |

The **detail** a rule matches against is derived from the call's arguments:

- a `shell` command, clipped to 200 characters;
- a file path for the file tools (with `(append)` or `(create)` appended when the
  write is not an overwrite);
- a ledger key for the `progress` tool.

Pattern matching is simple:

- no pattern matches any call of that tool;
- a pattern ending in `*` matches when the detail **starts with** the part before
  the `*`;
- any other pattern matches only on **exact equality**.

Rules are checked in order and the first match wins. Saved rules are placed before
config rules when the session starts, so a rule you created interactively takes
precedence over the same rule in `imurun.json`.

### Example

```jsonc
{
  "permissions": {
    "mode": "manual",
    "rules": [
      { "tool": "shell", "pattern": "git status*", "action": "allow" },
      { "tool": "shell", "pattern": "git push*", "action": "ask" },
      { "tool": "shell", "pattern": "rm -rf *", "action": "deny" },
      { "tool": "write", "pattern": "src/*", "action": "allow" }
    ]
  }
}
```

With that in place, in manual mode `git status` runs silently, `git push` asks, an
`rm -rf` command is refused, writes under `src/` are allowed, and any other shell
command asks.

## Personalizing: always allow and deny always

When a call asks, the TUI shows a dialog with four choices:

```text
write src/app.ts
[Y]es / [n]o / [a]lways / [d]eny-always
```

- **Yes** allows this call only.
- **No** refuses it.
- **Always** allows the call **and remembers it**: a saved rule is written, scoped
  to the project, so the same call will not ask again.
- **Deny always** refuses it and saves a matching deny rule.

Saved rules live in the local database, are loaded on the next start, and are
merged ahead of the config rules.

## When there is no one to ask

The decision to ask is only useful if something can answer it. If a call results
in `ask` and there is no interactive handler:

- `imurun run "..."` prints a "permission required" notice and refuses, telling you
  to re-run with `--yes` to approve automatically (or to add an allow rule).
- `imurun run "..." --yes` auto-approves every call its mode would otherwise ask
  about.
- In the TUI, the dialog above is always available.

In every case the refusal is reported back to the model as a normal tool error, so
it can adapt rather than crash.

## Disabling a tool entirely

`disabledTools` removes a tool from consideration before anything else: a call to a
disabled tool is denied no matter the mode or the rules. It is how an agent's tool
set is narrowed (see [Agents](agents.md)), and it is a hard stop rather than a
prompt.

## Where to go next

- The tools these rules gate: [Tools](tools.md).
- The `permissions` fields and defaults: [Configuration](configuration.md#permissions).
- The `/permission` command and the picker: [Slash commands](slash-commands.md).
- The footer that shows the mode: [The TUI](the-tui.md).
