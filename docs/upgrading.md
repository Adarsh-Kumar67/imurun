# Upgrading IMURUN

**What this covers:** how to move to a newer IMURUN from any way it was
installed, what each path actually runs, what happens to your models and
memory, and what to do when the automatic path cannot finish.

## The one command

```bash
imurun update
```

It works out how this copy was installed, prints the exact command or download
it will use, and then does it. Nothing is installed until you ask: the check
reads one small version field from npm and one from the GitHub release; the
install is a separate step.

```bash
imurun update check        # is there a newer release? (installs nothing)
imurun update --dry-run    # what would this installation run? (changes nothing)
imurun update --yes        # no confirmation prompt (for scripts)
```

Inside the interface the same thing is `/update`, and `/update check` only
reports. When `tui.autoUpdate` is `true` (the default), IMURUN mentions a new
release when it opens — and still will not install it without being asked.

## The matrix

| Installed with | Detected by | `imurun update` does |
| --- | --- | --- |
| npm | `node_modules`, or `IMURUN_INSTALL=npm` | `npm install -g imurun@latest` |
| Bun global | a path under `.bun/install/global` | `bun add -g imurun@latest` |
| pnpm global | a path under `pnpm/global` | `pnpm add -g imurun@latest` |
| pip / PyPI | `IMURUN_INSTALL=pip` from the launcher | `python -m pip install --upgrade imurun` |
| downloaded binary | a compiled program that is not a JS runtime | downloads the release asset and swaps it in place |
| source checkout | `packages/cli/src/index.ts` | `git pull --ff-only` then `bun install` |
| npx | a path under `_npx` | nothing — it suggests `npx imurun@latest` |

Two details worth knowing:

- **npm-style installs fall back to the release tarball.** If the registry is
  unreachable but GitHub is not, the update installs
  `imurun-npm.tgz` from the release instead, which is the same package.
- **pip upgrades the launcher, not the program.** The Python package is a thin
  launcher that downloads the compiled program. After
  `pip install --upgrade imurun`, the launcher notices that the program it has
  cached was fetched by a different version and downloads the matching one on
  its next start. If that download fails (offline, or a release that is not up
  yet), it keeps using the program it already has rather than refusing to
  start.

## What happens to your data

Nothing. An upgrade replaces the program; `~/.imurun` — models, engines,
memory, sessions, configuration — is never touched by any upgrade path, and no
upgrade deletes a source checkout.

## The binary path, in detail

A downloaded executable is replaced in place:

1. The new asset for your platform is downloaded
   (`imurun-windows-x64.exe`, `imurun-linux-arm64`, and so on).
2. It is checked before it is used: an HTML error page from a proxy is refused,
   and the old program is left exactly where it was.
3. It is written beside the old one and moved into place. On Windows, where a
   running executable cannot be overwritten, the old one is renamed aside and
   deleted a moment after the process exits — and the next start sweeps up
   anything left behind.

Nothing is copied into your `PATH` by the update; the file you already run is
the file that gets replaced. Start IMURUN again to use it.

If the directory is not writable (for example a binary in `/usr/local/bin`
without `sudo`), the update says so and prints the URL to download by hand.

## The source-checkout path, in detail

A checkout is updated the way a checkout should be: `git pull --ff-only` and
then `bun install`. `--ff-only` means a checkout with local commits or
conflicts is left untouched and reported rather than being merged or reset.
Your work is never discarded.

## If the update cannot finish

Every path either completes or explains what to do. The common cases:

| What you see | What it means |
| --- | --- |
| "the install did not finish" | The package manager failed. The by-hand command is printed. |
| "could not replace the program" | The download or the file move failed; the URL and target path are printed. |
| "git could not fast-forward" | The checkout has local changes or has diverged. Resolve it, then `bun install`. |
| "could not reach the registry; could not reach GitHub" | Offline, or both hosts are blocked. The release page is printed. |

Nothing is left half-written in any of these cases: the old program keeps
working.

## Related

- How each install method works: [Installation](installation.md).
- Removing it again, and what is kept: [Installation § Uninstall](installation.md#uninstall).
- The CLI reference for the command and its flags: [CLI reference](cli-reference.md#imurun-update).
