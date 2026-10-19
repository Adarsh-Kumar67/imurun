# Getting started

**What this covers:** installing IMURUN, opening it for the first time, letting
the setup wizard get a model running, running a single task without the
interface, and the handful of ideas (model, session, agent, context,
permissions) you need before the other guides make sense.

## 1. Install

IMURUN is a Bun program. Install [Bun](https://bun.sh) 1.2 or newer first, then
install the package:

```bash
npm install -g imurun
```

There are other ways to run it, including standalone binaries that bundle Bun
and do not need it on your PATH. See [Installation](installation.md) for the
full set of options and how to verify the install.

## 2. Open it

```bash
imurun
```

With no arguments and a terminal attached, this opens the interactive UI
(pictured and described in [The TUI](the-tui.md)). If there is no model your
machine can use yet, the **setup wizard** runs first.

## 3. Let the setup wizard get you running

The wizard asks one question — should models run on this machine or online — and
then takes the shortest path to a working model. `Esc` steps back through the
questions rather than cancelling everything.

- **On this machine.** If you have used a local model before, it reuses it. If
  you have models installed, it lets you pick one. If you have nothing, it
  detects your hardware, recommends the best-fitting model in the catalog, shows
  you what it is (and roughly how big it is), and installs it along with the
  inference engine after a single confirmation. Download progress runs on one
  line, and the download can be resumed if it is interrupted. See
  [Local models](local-models.md).
- **An online provider.** It reuses the provider you used last, or walks you
  through pasting a key for one of the built-in presets. See
  [Providers](providers.md).

If your machine already has a usable model, none of this happens: `imurun` loads
the model and drops you at the prompt.

## 4. Talk to it

At the prompt, type a message and press `Enter`. The model streams its answer,
and any tool it uses (reading a file, running a command, searching the project)
appears inline. Files it wants to write or commands it wants to run are subject
to the permission mode; the default is **auto**, so nothing stops to ask unless
you change it. The footer says which mode is active.

Everything is also reachable from slash commands — press `/` for the list or
`Tab` to complete. `/help` prints the full list, and
[Slash commands](slash-commands.md) documents each one.

## 5. Run one task without the interface

For scripts, pipes, and quick jobs, `imurun run` executes a single task and
exits:

```bash
imurun run "explain what this project does"
imurun run "add tests for auth.ts" --yes
imurun run "fix the login bug" --model local/qwen2.5-coder-7b
```

On a brand-new machine, `imurun run` sets the machine up by itself the first
time: with no model installed it picks the best-fitting one, installs the
engine, and runs, with no prompts. Only the model's streamed answer goes to
stdout; progress and reasoning go to stderr, so the output stays pipeable. See
[CLI reference](cli-reference.md#imurun-run).

## 6. Look at what this machine can run

```bash
imurun models
```

This prints your detected hardware, a tier and score, how much disk your models
use, the models that fit, and the quantization each would install at. It is
fully offline. See [Models](models.md).

## The ideas you need before the rest

| Idea | One line |
| --- | --- |
| Model | The LLM doing the work. Local by default; an online provider is optional. See [Models](models.md). |
| Session | A saved conversation, stored in a per-project database and resumable. |
| Agent | A working mode with its own prompt and tool set (build, plan, general, explore). See [Agents](agents.md). |
| Tool | A capability the model can call: read, write, edit, shell, search, and more. See [Tools](tools.md). |
| Context | The model's window, treated as a hard budget with automatic compaction. See [The TUI](the-tui.md#context-compaction-and-resumability). |
| Permission | Whether a tool call runs, asks first, or is refused. See [Permissions](permissions.md). |

## Where to go next

- Understand the screen and keys: [The TUI](the-tui.md).
- Keep the model warm and control the daemon: [Runtime](runtime.md).
- Cut your first model's disk use or change where it runs: [Configuration](configuration.md).
- Make the agent remember things: [Memory](memory.md).
- Search your codebase offline: [RAG](rag.md).
