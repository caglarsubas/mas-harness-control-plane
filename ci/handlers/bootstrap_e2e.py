#!/usr/bin/env python3
"""Run deterministic CTRL-001 source/build acceptance and remove build output."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(*argv: str) -> None:
    result = subprocess.run(argv, cwd=ROOT, shell=False, check=False)
    if result.returncode:
        raise SystemExit(result.returncode)


def main() -> None:
    build = ROOT / "apps/control-web/.next"
    if build.exists():
        shutil.rmtree(build)
    run("npm", "run", "typecheck")
    run("npm", "test")
    run("python3", "-m", "unittest", "discover", "-s", "tests/bootstrap", "-p", "test_*.py")
    run("npm", "run", "build")
    server = build / "standalone/apps/control-web/server.js"
    if not server.is_file():
        raise SystemExit("bootstrap e2e refused: standalone Next server is absent")
    shutil.rmtree(build)
    print("bootstrap e2e passed: auth/session, isolation, health, worker, SQL, deployment source, types, tests, and standalone build")


if __name__ == "__main__":
    main()
