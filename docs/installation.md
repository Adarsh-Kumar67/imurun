# Installation

**What this covers:** the requirements to run IMURUN, the three ways to install
it (npm, a standalone binary, or from source), how to verify the install, where
its files go, and how to remove it. It does not cover choosing a model — for
that, see [Local models](local-models.md).

## Requirements

- **Bun 1.2 or newer** on your PATH. The workspace declares `engines.bun` as
  `>=1.2.0` at the root and the session store uses Bun's built-in `bun:sqlite`,
  so a plain Node runtime is not enough for the packaged CLI. Standalone
  binaries embed Bun and do not need it installed.
- **Disk space** for a model. The smallest catalog model is a few gigabytes; the
  installer checks free space before downloading and tells you the impact.
- No account, key, or network connection is required for local use. IMURUN is
  offline-first and sends no telemetry. Every dependency it ships is free and
  open source.

## Platforms

IMURUN runs on Windows, macOS, and Linux, and the CI matrix runs the type
checker and the test suite on all three, so a platform-specific break is caught
on the platform it breaks.

Everything platform-specific resolves at run time, in one place
(`packages/util/src/platform.ts`):

| Concern | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Shell the `shell` tool uses | Git Bash if installed, then `bash` on PATH, then `cmd` | `$SHELL`, else `/bin/sh` | `$SHELL`, else `/bin/sh` |
| Opening a file or link | `cmd /c start` | `open` | `xdg-open` |
| Screenshot | PowerShell + .NET | `screencapture` | `grim`, `scrot`, `gnome-screenshot`, `spectacle`, or `import` |
| Clipboard for `/copy` | `clip` | `pbcopy` | `wl-copy`, `xclip`, or `xsel` |
| Engine builds | Vulkan, CUDA, or CPU | Metal or CPU | Vulkan, CUDA, ROCm, or CPU |

On macOS, `bun` installs with `brew install oven-sh/bun/bun`; on Linux, with the
official install script or your package manager. Nothing else differs: the same
commands, the same files under `~/.imurun`, and the same catalog of models.

## Option 1 — install from npm

```bash
npm install -g imurun
```

This installs the `imurun` command on your PATH (npm's global bin directory is
on PATH by default on every platform), so `imurun` works from any directory.
The published payload is a single self-contained JavaScript bundle with no
`node_modules`, run by a small launcher. Bun 1.2+ must be on PATH.

**The install sets the machine up.** When the install finishes, IMURUN looks
at the machine, picks the model that fits it, installs the inference engine
and downloads the weights — so the command is ready to answer a question
instead of half-installed. It never fails the install: if the download cannot
finish, the program is still there and `imurun setup` will do it later.

To install the program alone and set the machine up later:

```bash
IMURUN_SKIP_SETUP=1 npm install -g imurun
```

**If npm does not run the setup.** npm 11 only runs a package's install
scripts when that package has been allowed to, and it says so during the
install. Two ways forward, and the second is the one to prefer:

```bash
# 1. allow this one package's script, and install again
npm install -g --allow-scripts=imurun imurun

# 2. or let the first run do it: the program sets the machine up the first
#    time it starts, with no questions
imurun
```

The first run always makes the machine ready, whether the install script ran
or not. `imurun setup` does the same thing by hand.

Verify:

```bash
imurun --version
```

which prints the version (`imurun 0.1.11` at the time of writing).

## Option 1b — install with pip

```bash
pip install imurun
```

If you work in Python, this is the shortest route. The package installs one
`imurun` command on your PATH. It is a thin launcher: on the first run it
downloads the standalone executable that matches your machine (Windows, Linux
or macOS, x64 or arm64) from the GitHub releases, caches it under
`~/.imurun/python`, sets the machine up the same way the npm install does,
and runs it. Nothing is installed system-wide, no administrator rights are
needed, and later runs start instantly.

**pip does not upgrade what is already installed.** `pip install imurun` on a
machine that already has it leaves the old copy in place, which is how people
end up running a version from months ago. Use:

```bash
pip install --upgrade imurun
```

The launcher also checks PyPI on every run and says so when a newer version
has been published, so a stale copy is never silent.

Verify:

```bash
imurun --version
```

The command is identical to the npm one, so every example in this guide works
exactly as written.

## Option 2 — install from GitHub

Everything published to npm is also attached to each
[GitHub release](https://github.com/shubham001312/imurun/releases), so the same
install works without an npm account.

**With npm (needs Bun 1.2+):**

```bash
npm install -g https://github.com/shubham001312/imurun/releases/latest/download/imurun-npm.tgz
```

**Standalone binary (needs nothing else):** download the file for your platform
from the [latest release](https://github.com/shubham001312/imurun/releases/latest)
and put it on your PATH:

```powershell
# Windows (PowerShell) — into a folder that is already on PATH
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Programs\imurun" | Out-Null
Invoke-WebRequest -Uri "https://github.com/shubham001312/imurun/releases/latest/download/imurun-windows-x64.exe" `
  -OutFile "$env:LOCALAPPDATA\Programs\imurun\imurun.exe"
```

```bash
# macOS Apple Silicon / Linux x64 — into /usr/local/bin
sudo curl -L -o /usr/local/bin/imurun \
  https://github.com/shubham001312/imurun/releases/latest/download/imurun-darwin-arm64   # or imurun-linux-x64
sudo chmod +x /usr/local/bin/imurun
```

Verify with `imurun --version` exactly as above.

## Option 3 — standalone binary, built from source

Standalone executables are compiled with `bun build --compile`, so the runtime
is embedded and Bun is not required. They are staged as
`@imurun/<os>-<arch>` packages that the main package depends on optionally; the
launcher uses the native binary when a matching one is installed and falls back
to the JavaScript bundle otherwise. Build them from source with:

```bash
bun run package                     # bundle + stage the npm package
bun run package:binaries            # ...and compile for this machine
bun run package -- --targets=bun-windows-x64,bun-linux-x64,bun-darwin-arm64
bun run package -- --out=dist/release
```

Everything is staged under `dist/package/` (gitignored). The script only writes
files; it never touches the network or the registry. `bun run package` prints the
exact `npm install -g` line for the staged build. The published version comes
from `packages/cli/package.json`, so a release is a one-line bump.

To publish a release (npm tarball + binaries as GitHub release assets), run:

```bash
GH_TOKEN=... bun run release                      # all five platforms
bun run release -- --dry-run                      # stage and print, publish nothing
bun run release -- --targets=bun-windows-x64,bun-linux-x64
```

The token is read from the environment only — it is never written to disk or
logged. The script's header comment is the full reference.

## Option 4 — run from source

From a checkout of the workspace:

```bash
bun install        # install workspace dependencies
bun run dev        # launch the CLI in development mode
bun run typecheck  # type check everything
bun test           # run the test suite
bun run build      # bundle every package
bun run smoke      # the M1 verification demo
```

On Windows, `imurun.cmd` runs the CLI from source without a global install:

```powershell
imurun.cmd chat
```

There are also diagnostics that print a frame or explain a decision without a
terminal:

```bash
bun run scripts/demo-tui-frame.ts    # render one complete UI frame as text
bun run scripts/diag-context.ts      # the window each model loads, and why
bun run scripts/demo-run.ts          # an end-to-end agent turn with a stub model
```

## Entry points

- `imurun` with no arguments opens the interactive UI when a terminal is
  attached. When input/output is piped (for example `imurun | cat`, or in CI),
  it prints a short usage summary instead.
- `imurun <subcommand>` runs one command and exits. The full list is in
  [CLI reference](cli-reference.md).
- `imurun --version` and `imurun -v` print the version and exit.

## Where files go

IMURUN keeps everything under `~/.imurun` (override with `IMURUN_HOME`). The
directories are created on first use:

| Path | Holds |
| --- | --- |
| `~/.imurun/imurun.json` | Global configuration. |
| `~/.imurun/models/` | Installed GGUF files, `installed.json`, and the engine registry under `models/engines/`. |
| `~/.imurun/engines/llama.cpp/<release>/` | Downloaded and verified `llama-server` builds, with `active.json` recording the one that runs here. |
| `~/.imurun/data/` | SQLite databases (global plus one per project). |
| `~/.imurun/logs/runtime.log` | Runtime log (server stderr). |
| `~/.imurun/memory/` | Durable notes, per-session digests, the progress ledger, and the RAG index. |
| `~/.imurun/skills/` | User and imported skills. |
| `~/.imurun/agents/` | User-created agents. |
| `~/.imurun/cache/` | Downloaded assets and caches. |

Per-project state lives under `<project>/.imurun/` (`PLAN.md`, `todos.md`,
`agents/`, `skills/`). The full layout, including project databases, is in
[Local models](local-models.md#where-files-live) and
[Configuration](configuration.md#where-config-lives).

## Uninstall

The program and your data are two different things, and uninstalling treats
them that way:

```bash
imurun uninstall              # remove the program; keep models, memory, config
imurun uninstall --dry-run    # say what would be removed
imurun uninstall --purge      # remove ~/.imurun too
```

It detects how IMURUN was installed (npm, pip, or a standalone binary) and
uses the matching uninstaller. Inside the interface, `/uninstall` does the
same and asks twice — once for the program, once for the data, the second
defaulting to "keep".

If you would rather do it by hand:

```bash
npm uninstall -g imurun       # or: pip uninstall imurun
```

That removes the command but leaves your models, configuration, memory, and
sessions under `~/.imurun`. To reclaim that space from inside IMURUN, use
`imurun models clean --yes` (add `--engine` to include the engine binaries) and
delete `~/.imurun` when you want to remove everything.

## Models larger than the machine

Everything above runs a model that fits in memory. The deep engine lifts that
limit by streaming a model's layers from disk, so a 32B or 72B model answers
on a laptop with a 4 GB card — slowly. It is a separate install because it is
a separate 2.5 GB of PyTorch:

```bash
imurun setup --deep
imurun deep Qwen/Qwen2.5-Coder-32B-Instruct
```

See [Deep models](deep-models.md) for the costs and the details.

## License

IMURUN is MIT licensed, © 2026 ImuTechz. See the repository's `LICENSE` file.
The models and skills it downloads carry their own licenses, which the catalog
and the skill importer both report.
