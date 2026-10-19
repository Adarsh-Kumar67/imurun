# Tools

**What this covers:** every tool the model can call — its description, its
arguments, and the limits IMURUN enforces on it. It documents the 13 tools in the
base registry plus the `task` tool, which the interface adds. Which tools an agent
can see is set by the agent (see [Agents](agents.md)).

## The tool set

The base registry registers 13 tools; the interactive UI registers a 14th,
`task`, which needs the subagent runner. The default agent has all of them; the
`plan` agent has the read-only subset.

| Tool | Purpose | Needs approval |
| --- | --- | --- |
| `read` | Read a text file with line numbers. | No |
| `write` | Create or overwrite a file (small pieces). | Yes |
| `edit` | Replace an exact string in a file. | Yes |
| `shell` | Run a command through the platform shell. | Yes |
| `glob` | Find files by pattern, newest first. | No |
| `grep` | Search file contents with a regex. | No |
| `code_search` | Search the whole project via the offline index. | No |
| `memory` | Save and recall durable facts. | No |
| `progress` | Record where a piece of work is. | No |
| `todo` | Keep the live checklist. | No |
| `plan` | Write `.imurun/PLAN.md`. | No |
| `web_search` | Search the internet. | No |
| `web_fetch` | Download and read a web page. | No |
| `task` | Delegate to a subagent. | No |

"Needs approval" reflects the permission lists: the no-approval tools are
auto-allowed, and the others ask (or are refused) depending on the mode. See
[Permissions](permissions.md).

## read

Read a file from the filesystem and return its contents with line numbers.
Relative paths resolve against the project directory.

| Argument | Type | Notes |
| --- | --- | --- |
| `path` | string (required) | Relative or absolute. |
| `offset` | number | 1-based line to start from. |
| `limit` | number | Maximum lines to return. |

Limits: a file larger than **512 KB** is refused with a message suggesting
`grep` or `shell`; a binary file (one containing a NUL byte in its first 8 KB) is
reported but not decoded; and lines longer than **2000 characters** are clipped.
A path that is a directory is rejected.

## write

Write content to a file, creating it (and parent directories) if needed.

| Argument | Type | Notes |
| --- | --- | --- |
| `path` | string (required) | Relative or absolute. |
| `content` | string (required) | Content to write. |
| `mode` | string | `overwrite` (default), `append`, or `create`. |

`create` fails if the file already exists; `append` adds to the end (inserting a
newline first if the file does not end with one); `overwrite` replaces the file.
Writes are atomic. The tool records the file in the project ledger.

There is no size limit: write the whole file in one call when the model can emit
it. If its output is cut off mid-call, that call never executes and nothing
reaches disk — then create the file with the first section and append the rest
with `mode: "append"`. After a write the tool checks what landed and, for
code-like files, says so when the result looks structurally unfinished (an
unclosed brace, an unterminated string, invalid JSON), so the model can continue
instead of running a broken file. A write or edit also marks the project's RAG
index stale so the next search sees the new contents.

## edit

Replace an exact string in a file.

| Argument | Type | Notes |
| --- | --- | --- |
| `path` | string (required) | Relative or absolute. |
| `oldString` | string (required) | Exact text to find, including whitespace. |
| `newString` | string (required) | Replacement text. |
| `replaceAll` | boolean | Replace every occurrence (default: require uniqueness). |

The old string must exist and must be **unique** in the file, unless
`replaceAll` is true. If it is missing, the result tells the model to read the
file first and copy the exact text; if it appears more than once, it reports the
count and suggests more surrounding context or `replaceAll`. Editing is atomic
and also marks the RAG index stale.

## shell

Run a command through a real shell in the project directory.

IMURUN runs commands in a **POSIX** shell wherever one exists: the `bash` that
ships with Git for Windows, or `$SHELL`/`/bin/sh` on macOS and Linux. That means
`grep`, `sed`, `cat`, `head`, `tail`, `awk`, `find`, pipes, `&&` and `$VAR`
behave exactly as they do on Linux and macOS, which is what a coding model writes
by default. Only a machine with no POSIX shell installed at all falls back to
`cmd`; when that happens the tool description says so, so the model stops
reaching for tools that are not there. On Windows the Microsoft Store's `bash`
alias (which raises WSL) is never used — only a real shell is.

| Argument | Type | Notes |
| --- | --- | --- |
| `command` | string (required) | The command to run. |
| `workdir` | string | Directory to run in. |
| `timeoutMs` | number | Timeout in milliseconds (default 120000). |
| `background` | boolean | Start detached and return immediately. |

Limits: the default timeout is **120 seconds**, capped at **10 minutes**; output
is clipped to **100000 characters**, keeping the head and the tail; the return
value includes stdout, stderr, and the exit code. With `background: true` the
command is detached and nothing is captured — this is what makes it usable for
dev servers, watchers, and opening applications or URLs.

Paths inside the shell are POSIX ones. Git bash maps its mounts into place, so
the Windows temp directory shows up as `/tmp` and `C:\Users\you\proj` as
`/c/Users/you/proj`; a `pwd` therefore prints the POSIX form of the directory the
tool was given. The tool's own `workdir` argument accepts whatever the rest of
IMURUN accepts — Windows or POSIX style.

## glob

Find files matching a glob pattern (for example `**/*.ts`), sorted by
modification time, newest first. Backed by Bun's native glob scanner.

| Argument | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | e.g. `**/*.ts`. |
| `path` | string | Directory to search (default: project). |
| `limit` | number | Maximum results (default 100). |

Limits: **100** results by default, up to **500**. Well-known directories are
always skipped: `node_modules`, `.git`, `.svn`, `.hg`, `dist`, `build`, `out`,
`target`, `.next`, `.nuxt`, `.cache`, `__pycache__`, `.venv`, `venv`, `.idea`,
`.vscode-test`, and `coverage`.

## grep

Search file contents for a regular expression, returning matching lines with
paths and line numbers.

| Argument | Type | Notes |
| --- | --- | --- |
| `pattern` | string (required) | A regular expression. |
| `path` | string | Directory or file to search. |
| `include` | string | Glob to filter files, e.g. `*.ts`. |
| `caseSensitive` | boolean | Default true. |
| `limit` | number | Maximum matches (default 100). |

Limits: **100** matches by default, up to **1000**; files larger than **1 MB**
are skipped; binary files are skipped; the same ignored directories as `glob`
are skipped; and matched lines longer than 300 characters are truncated. The
walk is bounded to a depth of 24.

## code_search

Search the whole project at once and get the most relevant places, with file
paths, line ranges, and a short excerpt. It is backed by the offline project
index that stays up to date automatically, and works with no network, no model,
and nothing running. The agent is told to use it first, before reading files,
whenever it needs to find where something is defined or used.

| Argument | Type | Notes |
| --- | --- | --- |
| `query` | string (required) | Natural language or identifiers. |
| `path` | string | Restrict matches to paths containing this fragment. |
| `limit` | number | Maximum results (default 8, max 30). |

See [RAG](rag.md) for how the index is built and kept fresh.

## memory

Save and recall durable information across sessions: preferences, project facts,
decisions, and open todos.

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string (required) | `remember`, `recall`, `forget`, or `todos`. |
| `text` | string | For `remember`: the note, as one self-contained sentence. |
| `kind` | string | For `remember`: `fact`, `preference`, `user_style`, `credential`, `todo`, or `note` (default `note`). |
| `tags` | string | For `remember`: comma-separated tags. |
| `query` | string | For `recall`: what to search for. |
| `ref` | string | For `forget`: a note id or a text fragment. |

Recall returns up to 8 relevant entries. A note saved with `kind=credential` is
encrypted before it reaches disk and is never injected into a prompt; the model
only sees it when it explicitly recalls it. See [Memory](memory.md).

## progress

Record where a piece of work is so it can be resumed exactly, even after an
interruption or restart. This is the project's key/value ledger.

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string (required) | `list`, `set`, `remove`, or `clear`. |
| `key` | string | Entry key, e.g. `file:src/app.ts`. |
| `value` | string | One-line description of the state. |
| `status` | string | `open` (default) or `done`. |

Keys should be short and stable; values should be one line. The ledger keeps up
to **200** entries and is also shown, in part, in the system prompt on resume
(see [Memory](memory.md#the-progress-ledger)).

## todo

Write down and keep track of the steps of a task. This is the `.imurun/todos.md`
list that the side panel shows ticking over.

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string (required) | `plan`, `add`, `list`, `start`, `done`, `reopen`, `remove`, `clear-done`, or `clear`. |
| `todos` | array | For `plan`: the full ordered list (strings, or `{title,status,detail}` objects). |
| `title` | string | For `add`: the step, one imperative line. |
| `detail` | string | For `add`: optional context. |
| `ref` | string | For `start`/`done`/`reopen`/`remove`: a number, id, or title fragment. |

`action=plan` replaces the whole list. Statuses are `open`, `doing`, and `done`,
shown as `☐`, `◐`, and `☑`. The list holds up to **100** items, and up to **20**
open ones are included in the prompt.

## plan

Write down what is about to be done, in `.imurun/PLAN.md`, before starting
anything that takes more than a couple of steps. A todo list says how far along
something is; a plan says what the task is.

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string (required) | `write`, `show`, `step`, `add-step`, `note`, or `clear`. |
| `goal` | string | For `write`: what the user asked for. |
| `approach` | string | For `write`: how you intend to get there. |
| `steps` | array | For `write`: ordered steps (strings, or `{title,files,status}` objects). |
| `ref` | string | For `step`: a number, id, or title fragment. |
| `status` | string | For `step`: `open` or `done`. |
| `title` | string | For `add-step`. |
| `files` | array | For `add-step`: files it touches. |
| `text` | string | For `note`: a line of context or a decision. |

The plan file outlives the session, so a later run or the user can see what was
intended and where it got to. Up to **15** steps are included in the prompt.

## web_search and web_fetch

Both are dependency-free and key-free by default. Search goes through
DuckDuckGo's HTML endpoint; fetch downloads a page and reduces it to readable
text.

`web_search`:

| Argument | Type | Notes |
| --- | --- | --- |
| `query` | string (required) | Phrased as you would type it into a search engine. |
| `limit` | number | Maximum results (default 6, max 15). |

`web_fetch`:

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string (required) | Absolute `http` or `https` URL. |
| `maxChars` | number | Maximum characters of text (default 12000). |

Shared limits: requests time out at **20 seconds**; at most **2 MB** is
downloaded per page (lower it with `web.maxPageKB`); fetched text is clamped
between 500 and **60000** characters; and only `http`/`https` scheme URLs are
allowed — anything else is refused. When the machine is offline the tools fail
with a plain "no network connection" message rather than hanging, which matters
for a local-first agent.

The search engine is chosen by `web.searchBackend`:

| Backend | Needs | Notes |
| --- | --- | --- |
| `duckduckgo` | nothing | The default. Reads the HTML endpoint; no key, no account. |
| `searxng` | `web.searxngURL` | Your own or a public instance, asked over its JSON API. |
| `brave` | `web.braveApiKey` (or `BRAVE_API_KEY`) | The Brave Search API, for a key-backed source. |

Asking for a backend you have not configured fails with a message naming the
setting, rather than quietly falling back to another engine.

`web.cacheFetches` (off by default) writes each fetched page into
`<project>/.imurun/web-cache/` as markdown. The project index picks those files up
on its next refresh, so a page the agent has already read becomes searchable
offline through `code_search` — one request, then no network. It is off by default
because it puts files in your project.

See [Configuration](configuration.md#web).

## task

Delegate a focused sub-task to a subagent working in its own context window,
which returns a concise report. Registered in the interactive UI; it needs the
session to provide a subagent runner.

| Argument | Type | Notes |
| --- | --- | --- |
| `action` | string | `one` (default) or `batch`. |
| `description` | string | Short (3–5 word) description, shown to the user. |
| `aim` | string | For `one`: what to achieve. |
| `files` | string | Files, directories, or symbols to look at. |
| `approach` | string | How far to go. |
| `rules` | string | Constraints. |
| `tools` | string | Tools it may use. |
| `expect` | string | What to return. |
| `prompt` | string | A full instruction, used as-is when the fields do not fit. |
| `agent` | string | Which subagent mode to use (defaults to the caller's). |
| `tasks` | array | For `batch`: several briefs, run concurrently. |

A brief needs an aim (or a full prompt). The full behaviour is described in
[Agents](agents.md#subagents-and-the-task-tool).

## Tool argument compaction

When a tool call is replayed to the model on a later turn, long strings inside
its arguments are shortened: anything past **400 characters** is replaced with a
note saying how many characters were not replayed. A `write` call carries an
entire file, and replaying that on every turn is what fills a small window; the
model can always `read` the file again if it needs the bytes. This is part of how
context is kept under budget — see
[The TUI](the-tui.md#context-compaction-and-resumability).
