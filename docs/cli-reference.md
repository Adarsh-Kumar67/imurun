# CLI reference

**What this covers:** every `imurun` subcommand, its flags, and worked examples.
It documents the 10 subcommands registered in `packages/cli/src/index.ts` plus
the top-level `--version` handling. For in-session commands, see
[Slash commands](slash-commands.md).

## Invoking IMURUN

```bash
imurun                 # interactive UI when a terminal is attached, else a usage summary
imurun <command> ...   # run one command and exit
imurun --version       # print the version and exit
imurun -v              # same as --version
imurun help [command]  # print general or per-command help
imurun <command> --help
```

When there are no arguments and stdin/stdout are not a TTY, IMURUN prints a short
usage summary rather than trying to open the UI.

## Subcommands at a glance

| Command | Summary |
| --- | --- |
| `chat` | Start the interactive chat UI. |
| `run` | Run a task non-interactively (one-shot mode). |
| `models` | Discover, install, and manage local models. |
| `sessions` | List past sessions for the current project. |
| `providers` | List, add, or remove LLM providers. |
| `runtime` | Manage the local inference runtime. |
| `skills` | List, inspect, search, and import skills. |
| `rag` | Search the offline project index, or refresh it. |
| `version` | Print the IMURUN version. |
| `help` | Show help for a command. |

## `imurun chat`

Start the interactive chat UI. This is what a bare `imurun` does when a terminal
is attached.

```
Usage: imurun chat [--dir <path>]
```

| Option | Type | Description |
| --- | --- | --- |
| `--dir` | string | Working directory (default: current). |

```bash
imurun chat
imurun chat --dir ./packages/core
```

If there is no terminal, it prints an error and suggests `imurun run`.

## `imurun run`

Run a task non-interactively. Only the model's final text goes to stdout;
progress, reasoning, tool cards, and notices go to stderr, so output is clean
when piped.

```
Usage: imurun run "<task>" [--model <ref>] [--agent <id>] [--yes] [--session <id>] [--dir <path>] [--no-install] [--max-steps <n>]
```

| Option | Short | Type | Description |
| --- | --- | --- | --- |
| `--model` | | string | Model reference, e.g. `local/qwen2.5-coder-7b`. |
| `--agent` | | string | Agent to run as, e.g. `build`, `plan` (default: `build`). |
| `--yes` | `-y` | boolean | Auto-approve all tool permissions. |
| `--session` | | string | Continue an existing session id. |
| `--dir` | | string | Working directory (default: current). |
| `--quiet` | `-q` | boolean | Only print the final answer. |
| `--no-install` | | boolean | Never auto-install a model, even when none is present. |
| `--max-steps` | | string | Optional cap on model↔tool rounds. Omitted, a run continues until the model stops asking for tools. |

Behaviour worth knowing:

- **Model resolution** goes explicit `--model` → session model → config model →
  default installed model. A bare name that matches an installed model is
  treated as local, and a path ending in `.gguf` is used as a raw file.
- **First-run setup.** On a machine with no model, and without `--no-install`,
  IMURUN picks the best-fitting catalog model, installs the engine, and runs —
  with no prompts. If nothing in the catalog fits, it says so and exits.
- **Permissions.** Without `--yes` there is no interactive approver, so an "ask"
  outcome is denied with a message telling you to re-run with `--yes`.
- **Runtime lifetime.** If IMURUN started the local runtime for this run, it
  takes it down again when the command returns and no other client is attached,
  freeing the RAM. This is why the command is safe to use in scripts.

```bash
imurun run "explain what this project does"
imurun run "add tests for auth.ts" --yes
imurun run "fix the login bug" --model local/qwen2.5-coder-7b
imurun run "summarise the diff" --agent plan --session ses_abc123
imurun run "what changed today" --quiet | tee answer.txt
```

At the end of a run (unless `--quiet`) it prints a line such as
`3 steps │ 1120+260 tokens │ 41s │ model local/qwen2.5-coder-7b`.

## `imurun models`

Discover, install, and manage local models. The default subcommand is
`recommend`.

```
Usage: imurun models [list|recommend|info <id>|install <id>|remove [<id>|--all]|search <query>|engine|clean] [--quant Q4_K_M] [--all] [--yes] [--keep-files] [--engine] [--refresh]
```

| Option | Short | Type | Description |
| --- | --- | --- | --- |
| `--quant` | | string | Quantization to install (e.g. `Q4_K_M`, `Q5_K_M`). |
| `--all` | | boolean | Show the whole catalog, or remove every installed model. |
| `--refresh` | | boolean | Re-detect hardware instead of using the cache. |
| `--yes` | `-y` | boolean | Confirm destructive actions (`remove --all`, `clean`). |
| `--keep-files` | | boolean | Unregister models but keep the GGUF files on disk. |
| `--engine` | | boolean | With `clean`: also remove the llama.cpp engine binaries. |

| Subcommand | Aliases | Does |
| --- | --- | --- |
| `list` | `ls` | Installed models plus recommendations (or the whole catalog with `--all`), with a hardware header. |
| `recommend` | `rec` | The best-fitting models for this machine, ranked, with reasons. |
| `info <id>` | | Full details for one catalog model and per-quant fit on this machine. |
| `install <id>` | | One-click download and install, engine included, with live progress. |
| `remove [<id>\|--all]` | `rm` | Delete one model, or all of them (needs `--yes` when removing all). |
| `search <query>` | | Search Hugging Face for GGUF repositories (raw results, not auto-installable). |
| `engine` | | Install or update the llama.cpp engine binary. |
| `clean` | | Show reclaimable space, or free it with `--yes` (add `--engine` to include engine binaries). |

```bash
imurun models                          # recommendations for this machine
imurun models list --all               # the whole catalog with fit marks
imurun models info qwen2.5-coder-7b
imurun models install qwen2.5-coder-7b
imurun models install qwen2.5-coder-14b --quant Q5_K_M
imurun models remove qwen2.5-coder-7b
imurun models remove --all --yes
imurun models clean --yes --engine
imurun models search deepseek coder
```

See [Models](models.md) and [Local models](local-models.md) for what the output
means and how installation works.

## `imurun sessions`

List past sessions for the current project.

```
Usage: imurun sessions [list] [--limit <n>] [--all] [--dir <path>]
```

| Option | Type | Description |
| --- | --- | --- |
| `--limit` | string | Maximum sessions to show (default 15). |
| `--all` | boolean | Include sessions from other projects. |
| `--dir` | string | Project directory (default: current). |

```bash
imurun sessions
imurun sessions list --limit 5
imurun sessions --all
```

Each row shows the session id, when it was last updated, a truncated title, and
a message count. Resume with `imurun run "..." --session <id>`.

## `imurun providers`

Inspect, add, or remove LLM providers. The default subcommand is `list`.

```
Usage: imurun providers [list | presets | add <preset> --key <k> [--url <u>] | remove <id>]
```

| Option | Type | Description |
| --- | --- | --- |
| `--dir` | string | Project directory (default: current). |
| `--key` | string | API key, or an `{env:VAR}` reference. |
| `--url` | string | Endpoint, for a custom OpenAI-compatible service. |
| `--model` | string | Remember this model as the active one. |

| Subcommand | Aliases | Does |
| --- | --- | --- |
| `list` | | Show configured providers with a readiness badge (`ready`, `unreachable`, `disabled`) and their models. |
| `presets` | | List the built-in provider presets and where to get a key. |
| `add <preset>` | | Write a provider from a preset into the global config. |
| `remove <id>` | `rm` | Remove a provider from the global config. |

```bash
imurun providers
imurun providers presets
imurun providers add groq --key "{env:GROQ_API_KEY}"
imurun providers add openai --key sk-... --model gpt-5.1
imurun providers add custom --url http://127.0.0.1:8000/v1 --key local
imurun providers remove groq
```

`add` accepts an `{env:VAR}` reference instead of a literal key, and always
writes to the global config. See [Providers](providers.md).

## `imurun runtime`

Manage the local inference runtime.

```
Usage: imurun runtime <status|start|stop|restart|logs> [--background] [--model <name|path>] [--engine llama-cpp|ollama] [--port <n>]
```

| Option | Short | Type | Description |
| --- | --- | --- | --- |
| `--background` | `-b` | boolean | Start with a detached supervisor (survives this terminal). |
| `--model` | | string | Ollama model name, or a path to a `.gguf` file. |
| `--engine` | | string | Engine to use: `llama-cpp` (default) or `ollama`. |
| `--port` | | string | Port for the local OpenAI-compatible API. |
| `--tail` | | string | Number of log lines to show (default 40), for `logs`. |

The default subcommand is `status`.

| Subcommand | Does |
| --- | --- |
| `status` | Engine, port, model, context window, uptime, supervisor, health, and engine availability. |
| `start` | Start and supervise; Ctrl+C stops. With `--background`, spawn a detached supervisor that unloads on idle or when clients disconnect. |
| `stop` | Stop everything and free RAM. |
| `restart` | Stop, then start. |
| `logs` | Show the tail of `~/.imurun/logs/runtime.log`. |

```bash
imurun runtime status
imurun runtime start --model qwen2.5-coder:7b --engine ollama
imurun runtime start --background
imurun runtime logs --tail 80
imurun runtime stop
```

See [Runtime](runtime.md).

## `imurun skills`

List, inspect, search, and import skills. The default subcommand is `list`.

```
Usage: imurun skills [list|show <id>|find <query>|sync [owner/repo]|dir] [--include-restricted] [--branch B] [--limit N]
```

| Option | Type | Description |
| --- | --- | --- |
| `--include-restricted` | boolean | Import source-available skills too (not recommended). |
| `--branch` | string | Git branch of the skill pack to read (default: `main`). |
| `--limit` | string | With `find`: how many matches to show (default 8). |
| `--all` | boolean | With `list`: show the description of every skill. |
| `--json` | boolean | Machine-readable output. |

| Subcommand | Aliases | Does |
| --- | --- | --- |
| `list` | `ls` | Everything available, grouped by source (built-in, imported, project). |
| `show <id>` | `print`, `cat` | Print one skill's instructions. A bare `imurun skills <id>` is shorthand. |
| `find <query>` | `search`, `match` | Show what the router would pick, with scores. |
| `sync [owner/repo]` | `import`, `add` | Import a published skill pack. |
| `dir` | `where` | Print where skills are read from. |

```bash
imurun skills
imurun skills show build-website
imurun skills find "add a dark mode toggle"
imurun skills sync                       # from anthropics/skills
imurun skills sync owner/repo --branch main
imurun skills dir
```

In `find`, a filled dot (`●`) marks a score at or above the router's threshold
of 3.0 — the point at which the skill is injected automatically — while a hollow
dot (`○`) is shown for context only. See [Skills](skills.md).

## `imurun rag`

Search the offline project index that backs `code_search`, or refresh it. The
default subcommand is `status`.

```
Usage: imurun rag [status|index|search <query>|clear] [--path <fragment>] [--limit N] [--json]
```

| Option | Type | Description |
| --- | --- | --- |
| `--path` | string | Restrict matches to paths containing this fragment. |
| `--limit` | string | Maximum results (default 10). |
| `--json` | boolean | Machine-readable output. |

| Subcommand | Aliases | Does |
| --- | --- | --- |
| `status` | `info` | Files, chunks, size, last update, snapshot path, and the `rag` settings in force. |
| `index` | `refresh` | Build or update the index now. |
| `search <query>` | `find`, `query` | Search the index. |
| `clear` | | Delete the index and its snapshot. |

A bare `imurun rag <words>` is shorthand for a search.

```bash
imurun rag
imurun rag index
imurun rag search "where are permissions checked"
imurun rag "runtime context size" --limit 5
imurun rag search permissions --path packages/core --json
imurun rag clear
```

See [RAG](rag.md).

## `imurun version` and `imurun help`

```bash
imurun version          # prints: imurun 0.1.2
imurun help             # the general command list
imurun help models      # help for one command
imurun models --help    # the same, via the command's own flag
```

`imurun --version` and `imurun -v` print the version without dispatching a
subcommand. Version 0.1.2 is defined in `packages/cli/src/version.ts`.
