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

This installs the `imurun` command. The published payload is a single
self-contained JavaScript bundle with no `node_modules`, run by a small
launcher.

Verify:

```bash
imurun --version
```

which prints the version (`imurun 0.1.0` at the time of writing).

## Option 2 — standalone binary

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

## Option 3 — run from source

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

```bash
npm uninstall -g imurun
```

That removes the command but leaves your models, configuration, memory, and
sessions under `~/.imurun`. To reclaim that space from inside IMURUN, use
`imurun models clean --yes` (add `--engine` to include the engine binaries) and
delete `~/.imurun` when you want to remove everything.

## License

IMURUN is MIT licensed, © 2026 ImuTechz. See the repository's `LICENSE` file.
The models and skills it downloads carry their own licenses, which the catalog
and the skill importer both report.
