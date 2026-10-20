# Slash commands

**What this covers:** every slash command in the interactive UI, what it does,
its usage, and its aliases. It is the reference for the 27 commands defined in
`packages/tui/src/commands.ts`. For shell subcommands instead of in-session
commands, see [CLI reference](cli-reference.md).

Type `/` at the prompt to open the completion menu, or `Tab` to complete. `/help`
prints the list, and `/help <command>` prints one command's summary, usage, and
aliases.

## The full list

| Command | Aliases | What it does | Usage |
| --- | --- | --- | --- |
| `/help` | — | Show commands, or details for one. | `/help [command]` |
| `/exit` | `/quit`, `/q` | Leave IMURUN and free the model's memory. | `/exit` |
| `/new` | — | Start a fresh session. | `/new` |
| `/session` | `/sessions`, `/resume` | Pick, rename, delete, or resume a session. | `/session [list\|rename <title>\|delete <ref>\|new\|<number\|id>]` |
| `/provider` | — | Add a cloud provider (OpenAI, Anthropic, Google, Groq, NVIDIA, OpenRouter…). | `/provider [list\|remove <id>\|<id>]` |
| `/setup` | `/wizard`, `/onboard` | Choose where models run: this machine or online. | `/setup` |
| `/plan` | `/plans` | Show the written plan (goal, approach, steps) and update it. | `/plan [show \| new <goal> \| done <n> \| reopen <n> \| note <text> \| open \| clear]` |
| `/todo` | `/todos` | Show or edit the plan the model is working through. | `/todo [list \| add <step> \| start <n> \| done <n> \| reopen <n> \| rm <n> \| clear-done]` |
| `/clear` | — | Clear the screen. | `/clear` |
| `/model` | — | Switch the model (opens a picker) or download more. | `/model [ref]` |
| `/models` | — | List installed models and machine recommendations. | `/models` |
| `/effort` | `/reasoning` | Set how hard the model thinks (`low`/`medium`/`high`/`max`). | `/effort [low\|medium\|high\|max]` |
| `/install` | — | Download a model from the catalog (shows disk impact). | `/install [model-id] [quant]` |
| `/remove` | — | Delete an installed model and free its disk space. | `/remove <id>` |
| `/agent` | — | Switch the active agent (opens a picker). | `/agent [id]` |
| `/agents` | — | List available agents. | `/agents` |
| `/skills` | — | Run a skill, list them, or import a published skill pack. | `/skills [id\|sync <owner/repo>]` |
| `/permission` | `/permissions`, `/approve` | Choose how tool calls are approved (`auto`, `manual`, `read-only`). | `/permission [auto\|manual\|readonly]` |
| `/queue` | — | Show, edit, drop, or clear messages queued behind the current turn. | `/queue [edit <n>\|drop <n>\|clear]` |
| `/memory` | - | Show what IMURUN remembers, search it, or tend the vault. | `/memory [query \| vault [tidy]]` |
| `/copy` | `/yank` | Copy the last answer, or a numbered code block, to the clipboard. | `/copy [list \| <n>]` |
| `/compact` | — | Free context now: fold older turns into the session summary. | `/compact` |
| `/tools` | — | List the tools available to the current agent. | `/tools` |
| `/cwd` | — | Show or change the working directory. | `/cwd [path]` |
| `/status` | — | Show model, agent, runtime, and storage status. | `/status` |
| `/runtime` | — | Control the local inference runtime. | `/runtime [status\|stop]` |
| `/rag` | — | Search the project index, or refresh it. | `/rag [status\|index\|search <query>\|clear]` |

## Notes on specific commands

### `/session`

`/session` with no argument opens the session picker. `list` prints past
sessions, `rename <title>` renames the current one, `delete <ref>` removes one,
`new` starts a fresh session, and a bare number or id resumes that session. The
same command is available from the shell as `imurun sessions`
([CLI reference](cli-reference.md#imurun-sessions)).

### `/provider`

`/provider` opens a picker; `list` shows configured providers and their
reachability, `remove <id>` deletes one, and a bare `<id>` selects an existing
one. Adding a provider is a short wizard (key, optionally a URL, then a model) in
which `Esc` steps back. See [Providers](providers.md).

### `/model` and `/models`

`/model` opens a picker; passing a reference such as `local/qwen2.5-coder-7b`
switches directly, and the picker can also start a download. `/models` lists what
is installed alongside recommendations for this machine. See
[Models](models.md).

### `/effort`

Sets the thinking budget for providers that accept one. The value is only sent
when the provider supports a reasoning effort; on a provider that does not, the
setting is remembered but not transmitted. If a provider rejects the value,
IMURUN steps it down (`max` → `high` → off) rather than failing the turn.

### `/permission`

Switches the approval mode. `auto` runs tools without asking, `manual` asks
before anything that changes the machine, and `readonly` refuses anything that
does. See [Permissions](permissions.md).

### `/plan` and `/todo`

`/plan` reads and edits `.imurun/PLAN.md` (goal, approach, ordered steps).
`/todo` reads and edits `.imurun/todos.md`, the checklist shown in the side
panel. Both survive restarts, so an interrupted run resumes from them. See
[Tools](tools.md#plan) and [Tools](tools.md#todo).

### `/rag`

`/rag` shows the project index status, including the settings in force
(`watching on/off`, `auto-inject on/off`, and how many chunks a turn may inject);
`index` builds or refreshes it, `search <query>` searches it, and `clear` deletes
it. The index is also what `code_search` uses, and what feeds the `SOURCES` section
of the side panel. See [RAG](rag.md).

### `/memory`

`/memory` shows the store, how many notes of each kind it holds, and the open
todos. `/memory <query>` searches notes and session digests.

`/memory vault` is about the second brain instead: its health score out of 100,
the cards currently in the prompt, and whether your persona file is in use.
`/memory vault tidy` repairs links that have exactly one plausible target, moves
duplicate titles to `.trash/` (keeping the most-used copy), writes aged tiers
back for editors, and regenerates `MEMORY.md`. Orphans are reported, never
deleted. See [Memory](memory.md#the-vault--the-second-brain).

### `/runtime`

`/runtime` (or `/runtime status`) shows whether the local runtime is running and
its engines; `/runtime stop` stops it and frees RAM. See [Runtime](runtime.md).

### `/copy`

Getting text out of the chat. A terminal already has a selection — hold `Shift`
and drag, or use the terminal's own copy key — and that keeps working here.

`/copy` is for the case a terminal cannot help with: a long block of code that
has scrolled away. `/copy` with no argument copies the model's last answer;
`/copy 3` copies the third-newest code block (either one shown in a reply or one
IMURUN previewed when writing a file); `/copy list` names them all with line
counts so you can pick.

The text goes to the platform's clipboard (`clip` on Windows, `pbcopy` on macOS,
`wl-copy`/`xclip`/`xsel` on Linux). If the machine has none of those, IMURUN
writes the text to a file in the temp directory and says where — the copy never
silently fails, and never silently "succeeds".
