"""The console entry point: ``imurun`` on PATH after ``pip install imurun``."""

from __future__ import annotations

import sys

from . import main

if __name__ == "__main__":
    sys.exit(main())
