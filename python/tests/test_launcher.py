"""
Tests for the Python launcher.

Everything here runs offline: the download is exercised against a local
``file://`` URL and a stubbed opener, never the real network.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import imurun  # noqa: E402


class PlatformKeyTests(unittest.TestCase):
    def test_the_key_names_the_asset_for_this_machine(self) -> None:
        key = imurun.platform_key()
        self.assertTrue(key.startswith("imurun-"), key)
        self.assertIn(key.split("-")[1], {"windows", "darwin", "linux"})

    def test_windows_gets_an_exe_and_others_do_not(self) -> None:
        original = imurun.is_windows
        try:
            imurun.is_windows = lambda: True  # type: ignore[assignment]
            self.assertTrue(imurun.binary_name().endswith(".exe"))
            imurun.is_windows = lambda: False  # type: ignore[assignment]
            self.assertFalse(imurun.binary_name().endswith(".exe"))
        finally:
            imurun.is_windows = original  # type: ignore[assignment]

    def test_the_download_url_points_at_the_latest_release(self) -> None:
        url = imurun.download_url()
        self.assertIn("releases/latest/download", url)
        self.assertIn(imurun.binary_name(), url)
        self.assertIn("shubham001312/imurun", url)


class CacheTests(unittest.TestCase):
    def test_the_cache_follows_imurun_home(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            os.environ["IMURUN_HOME"] = home
            try:
                path = imurun.launcher_path()
                self.assertTrue(str(path).startswith(home))
                self.assertIn(".imurun", str(path).replace(os.sep, "/"))
            finally:
                del os.environ["IMURUN_HOME"]

    def test_a_download_that_lands_moves_into_place_whole(self) -> None:
        """The file only appears at its final path once it has arrived."""
        with tempfile.TemporaryDirectory() as home:
            os.environ["IMURUN_HOME"] = home
            try:
                source = Path(home) / "payload.bin"
                source.write_bytes(b"imurun-binary-bytes")
                destination = imurun.launcher_path()

                seen: dict[str, bool] = {}

                def fake_urlopen(url, timeout=0):  # noqa: ANN001, ANN202
                    seen["destination_exists_mid_download"] = destination.exists()
                    return FakeResponse(source.read_bytes())

                original = imurun.urllib.request.urlopen
                imurun.urllib.request.urlopen = fake_urlopen  # type: ignore[assignment]
                try:
                    imurun.download_executable(destination, "https://example.invalid/payload")
                finally:
                    imurun.urllib.request.urlopen = original  # type: ignore[assignment]

                self.assertFalse(seen["destination_exists_mid_download"])
                self.assertTrue(destination.exists())
                self.assertEqual(destination.read_bytes(), b"imurun-binary-bytes")
                # No half-written file is left behind.
                self.assertFalse(destination.with_suffix(destination.suffix + ".part").exists())
            finally:
                del os.environ["IMURUN_HOME"]

    def test_a_failed_download_leaves_nothing_behind(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            os.environ["IMURUN_HOME"] = home
            try:
                destination = imurun.launcher_path()

                def broken_urlopen(url, timeout=0):  # noqa: ANN001, ANN202
                    raise imurun.urllib.error.URLError("no network")

                original = imurun.urllib.request.urlopen
                imurun.urllib.request.urlopen = broken_urlopen  # type: ignore[assignment]
                try:
                    with self.assertRaises(SystemExit):
                        imurun.download_executable(destination, "https://example.invalid/payload")
                finally:
                    imurun.urllib.request.urlopen = original  # type: ignore[assignment]

                self.assertFalse(destination.exists())
                self.assertFalse(destination.with_suffix(destination.suffix + ".part").exists())
            finally:
                del os.environ["IMURUN_HOME"]


class FakeResponse:
    """The little bit of a HTTP response the downloader actually uses."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.headers = {"Content-Length": str(len(payload))}

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            data, self._payload = self._payload, b""
            return data
        data, self._payload = self._payload[:size], self._payload[size:]
        return data

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None


class EntryPointTests(unittest.TestCase):
    def test_the_version_is_printed_without_touching_the_network(self) -> None:
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = imurun.main(["--version"])
        self.assertEqual(code, 0)
        self.assertIn("imurun", buffer.getvalue())

    def test_the_help_mentions_the_project(self) -> None:
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = imurun.main(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("imutechz.in", buffer.getvalue())

    def test_a_newer_release_on_pypi_is_reported(self) -> None:
        """An old copy is easy to keep: pip does not upgrade what is there."""
        import contextlib
        import io

        buffer = io.StringIO()
        original = imurun._latest_pypi_version
        imurun._latest_pypi_version = lambda: "99.0.0"
        try:
            with contextlib.redirect_stderr(buffer):
                imurun._report_newer_version()
        finally:
            imurun._latest_pypi_version = original  # type: ignore[assignment]
        self.assertIn("99.0.0", buffer.getvalue())
        self.assertIn("pip install --upgrade imurun", buffer.getvalue())

    def test_the_current_version_is_not_reported_as_outdated(self) -> None:
        import contextlib
        import io

        buffer = io.StringIO()
        original = imurun._latest_pypi_version
        imurun._latest_pypi_version = lambda: imurun.__version__
        try:
            with contextlib.redirect_stderr(buffer):
                imurun._report_newer_version()
        finally:
            imurun._latest_pypi_version = original  # type: ignore[assignment]
        self.assertEqual(buffer.getvalue(), "")

    def test_an_unreachable_pypi_is_not_an_error(self) -> None:
        original = imurun.urllib.request.urlopen
        imurun.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(  # type: ignore[assignment]
            imurun.urllib.error.URLError("offline")
        )
        try:
            self.assertIsNone(imurun._latest_pypi_version())
        finally:
            imurun.urllib.request.urlopen = original  # type: ignore[assignment]

    def test_the_pypi_answer_is_actually_read(self) -> None:
        """The reply is parsed, not assumed: a missing import would show here."""

        class FakeResponse:
            def __init__(self, payload: bytes) -> None:
                self._payload = payload

            def read(self) -> bytes:
                return self._payload

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original = imurun.urllib.request.urlopen
        imurun.urllib.request.urlopen = lambda *a, **k: FakeResponse(  # type: ignore[assignment]
            b'{"info": {"version": "9.9.9"}}'
        )
        try:
            self.assertEqual(imurun._latest_pypi_version(), "9.9.9")
        finally:
            imurun.urllib.request.urlopen = original  # type: ignore[assignment]

    def test_a_reply_without_a_version_is_ignored(self) -> None:
        class FakeResponse:
            def read(self) -> bytes:
                return b'{"info": {}}'

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

        original = imurun.urllib.request.urlopen
        imurun.urllib.request.urlopen = lambda *a, **k: FakeResponse()  # type: ignore[assignment]
        try:
            self.assertIsNone(imurun._latest_pypi_version())
        finally:
            imurun.urllib.request.urlopen = original  # type: ignore[assignment]


if __name__ == "__main__":
    unittest.main()
