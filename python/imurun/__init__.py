"""
IMURUN - the Python launcher.

``pip install imurun`` puts a single ``imurun`` command on your PATH. IMURUN
itself is a compiled program, so this package does the one thing a Python
install can do that a downloaded file cannot: pick the right build for the
machine, put it somewhere sensible, and run it.

The first run downloads the matching standalone executable from the project's
GitHub releases and caches it under ``~/.imurun/python``. Later runs start
straight away. Nothing is installed system-wide, no administrator rights are
needed, and the download is verified against the size published with the
release.

Two things the launcher takes care of, because they are the two that bite:

  * **The machine is set up.** Installing the program is only half of it: to
    run a model you also need the inference engine and a model file. The
    first run does that part, so the machine is ready rather than
    half-installed. ``IMURUN_SKIP_SETUP=1`` turns it off.
  * **An old copy is noticed.** ``pip install imurun`` does not upgrade an
    install that is already there, so a stale copy is easy to end up with.
    The launcher checks PyPI and says so when there is a newer one.

If you would rather install the program itself, see https://imutechz.in and the
project README - the same command works from npm (``npm install -g imurun``)
and from a standalone binary.
"""

from __future__ import annotations

import os
import platform
import shutil
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path

__all__ = ["__version__", "main", "launcher_path", "download_url"]

__version__ = "0.1.7"

#: Where the releases live. One place, so a move is a one-line change.
REPO = "shubham001312/imurun"

#: The fallback channel: the newest published release, whatever it is called.
LATEST = f"https://github.com/{REPO}/releases/latest/download"


def user_home() -> Path:
    """The user's home directory, resolved the way the platform expects."""
    override = os.environ.get("IMURUN_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home()


def cache_dir() -> Path:
    """Where the downloaded executable lives."""
    return user_home() / ".imurun" / "python"


def platform_key() -> str:
    """The release asset name for this machine, e.g. ``imurun-linux-x64``."""
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "windows":
        os_name = "windows"
    elif system == "darwin":
        os_name = "darwin"
    else:
        os_name = "linux"

    if machine in ("x86_64", "amd64", "x64"):
        arch = "x64"
    elif machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("i386", "i686", "x86"):
        arch = "x64"  # the 32-bit builds are not published; x64 is the closest
    else:
        arch = "x64"

    return f"imurun-{os_name}-{arch}"


def is_windows() -> bool:
    return platform.system().lower() == "windows"


def binary_name() -> str:
    """The file name the executable is stored under on this machine."""
    return f"{platform_key()}.exe" if is_windows() else platform_key()


def download_url() -> str:
    """Where the executable for this machine is fetched from."""
    return f"{LATEST}/{binary_name()}"


def launcher_path() -> Path:
    """The full path of the cached executable."""
    return cache_dir() / binary_name()


def _chmod_executable(path: Path) -> None:
    """Make the file runnable. A no-op on Windows, where the bit means nothing."""
    if is_windows():
        return
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def download_executable(destination: Path, url: str | None = None) -> Path:
    """
    Fetch the executable for this machine.

    The download lands in a temporary file first and is moved into place only
    once it has arrived whole, so an interrupted download never leaves a
    truncated program behind that a later run would happily try to execute.
    """
    source = url or download_url()
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_suffix(destination.suffix + ".part")

    print(f"Downloading IMURUN for this machine…\n  {source}", file=sys.stderr)
    try:
        with urllib.request.urlopen(source, timeout=120) as response:
            total = response.headers.get("Content-Length")
            expected = int(total) if total and total.isdigit() else 0
            written = 0
            with open(partial, "wb") as handle:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    handle.write(chunk)
                    written += len(chunk)
                    if expected:
                        percent = int(written * 100 / expected)
                        print(f"\r  {percent:3d}%  ({written >> 20} MB)", end="", file=sys.stderr)
        if expected and written != expected:
            raise OSError(f"the download was incomplete ({written} of {expected} bytes)")
    except urllib.error.URLError as error:
        partial.unlink(missing_ok=True)
        raise SystemExit(
            f"Could not download IMURUN: {error}\n"
            f"You can also install it directly:\n"
            f"  npm install -g imurun\n"
            f"  or download it from https://github.com/{REPO}/releases/latest"
        ) from error
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

    if expected:
        print(file=sys.stderr)
    _chmod_executable(partial)
    partial.replace(destination)
    return destination


def ensure_executable() -> Path:
    """Return the cached executable, downloading it the first time."""
    path = launcher_path()
    if path.exists():
        return path
    return download_executable(path)


def _run_setup(executable: Path) -> int:
    """
    Set the machine up on the first run.

    The engine and a model that fits are installed here, so a fresh install is
    ready to answer a question rather than half-installed. Any failure is
    reported and ignored: the program itself still runs.
    """
    if os.environ.get("IMURUN_SKIP_SETUP") == "1":
        return 0
    try:
        result = subprocess.run([str(executable), "setup", "--quiet"], check=False)
        return result.returncode
    except OSError as error:
        print(f"  The automatic setup did not run: {error}", file=sys.stderr)
        return 1


def _latest_pypi_version(timeout: float = 4.0) -> str | None:
    """
    The newest version on PyPI, or None when it cannot be reached.

    ``pip install imurun`` does not upgrade a copy that is already installed,
    so a stale one is easy to end up with. This is the check that says so.
    """
    if os.environ.get("IMURUN_NO_UPDATE_CHECK") == "1":
        return None
    try:
        with urllib.request.urlopen(
            "https://pypi.org/pypi/imurun/json", timeout=timeout
        ) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    version = body.get("info", {}).get("version")
    return version if isinstance(version, str) else None


def _report_newer_version() -> None:
    """Say so when a newer copy is published — the old one is easy to keep."""
    latest = _latest_pypi_version()
    if not latest or latest == __version__:
        return
    print(
        f"  A newer IMURUN is published: {latest} (this copy is {__version__}).",
        file=sys.stderr,
    )
    print(
        "  To update:  python -m pip install --upgrade imurun",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    """
    The ``imurun`` entry point.

    Everything after the command name is handed straight to the program, so
    ``imurun models install qwen2.5-coder-7b`` behaves exactly as it does when
    installed any other way.
    """
    args = list(sys.argv[1:] if argv is None else argv)

    if args and args[0] in ("--version", "-V"):
        print(f"imurun {__version__}")
        return 0

    if args and args[0] in ("--help", "-h") and len(args) == 1:
        print(__doc__.strip())
        print(f"\nProject: https://github.com/{REPO}")
        print("Website: https://imutechz.in")
        return 0

    # The program is told how it was installed, so an update uses the right
    # tool: pip here, npm for a global install.
    os.environ.setdefault("IMURUN_INSTALL", "pip")

    executable = ensure_executable()
    _report_newer_version()

    # A local build in the source tree wins, so a developer can run the
    # program they are editing without a download.
    local = Path.cwd() / "dist" / "imurun.js"
    if local.exists():
        return _run_bun(local, args)

    # The first run sets the machine up: the engine and a model that fits it.
    if not launcher_path().exists() or os.environ.get("IMURUN_SETUP_DONE") != "1":
        _run_setup(executable)
        os.environ["IMURUN_SETUP_DONE"] = "1"

    return _run(executable, args)


def _run(executable: Path, args: list[str]) -> int:
    """Run the executable, replacing this process when the platform allows it."""
    try:
        os.execv(str(executable), [str(executable), *args])
    except OSError:
        # execv replaces the process on POSIX; on Windows it is not available
        # for the same reason, so the child is spawned and waited on instead.
        import subprocess

        return subprocess.call([str(executable), *args])
    return 0


def _run_bun(bundle: Path, args: list[str]) -> int:
    """Run a local bundle with Bun, when Bun is available."""
    import subprocess

    bun = shutil.which("bun")
    if bun is None:
        raise SystemExit("Bun is required to run a local build: https://bun.sh")
    return subprocess.call([bun, str(bundle), *args])


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
