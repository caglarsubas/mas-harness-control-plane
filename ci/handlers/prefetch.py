#!/usr/bin/env python3
"""Verify and materialize CTRL-001 only from preprovisioned offline inputs."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = "fbd3d21da70167b0819caa1dfc017e7c673a1cbe"
EXPECTED_DEPENDENCIES = {
    "@prisma/client": "6.19.3",
    "ajv": "8.20.0",
    "next": "16.3.3",
    "react": "19.2.0",
    "react-dom": "19.2.0",
}
EXPECTED_DEV_DEPENDENCIES = {
    "@types/node": "24.13.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.5",
    "prisma": "6.19.3",
    "typescript": "5.9.3",
    "vitest": "4.1.11",
}
EXPECTED_LOCK = {
    "schemaVersion": "planeon.control.predecessor-lock/v1",
    "sdk002": {
        "commit": "92a8ebf8e705eb2bf7a4e5be89edc5e8aa062c08",
        "typescriptAttributesSha256": "922ed63c42c742cfc01ad61f880862b8a9312a1a3a647698995a6d426cc15a5c",
        "typescriptContextSha256": "526c851a8a598d1d49b47da4b0fc588c24dcdef974b76b7b21ec4d747ead7ae1",
        "typescriptDecoratorsSha256": "5f8d92fa84b8ad8c48f3319578ebb0f3f8b5abe9a33c86d86acd48a649f8f06d",
        "typescriptPackageSha256": "c74a05bb7e25f02b47ab24be5c215d1431947dbf882741ec4797141da9e494c0",
    },
    "ind001": {
        "commit": "a626437a18cd27d75cb96e0d846f56a235313c98",
        "commonContractsLockSha256": "81d7470e28b452cbf8de2e4903b47b5335709b09cf6375f78481057973d75c91",
        "commonJourneySha256": "950a6d21c68a35117a3cd36d67491cde85274ef911d78ff8585e1be8671db2fb",
        "commonPackSha256": "534246425cdf38fd4f311da1e4a587eadbffdb589d747435a081ed969ae978e9",
    },
    "met003": {
        "commit": "97da35afff79e1582b964b613472609a613ea81b",
        "policySha256": "77c1385d014db8562be215f03a806deafb66e38c6e7faed9167f53299dadd43e",
        "scannerSha256": "57fa7e94bf5657f0daf959d5229dfc2a53a0ab94793d1d5fa03a7513b1272fd7",
        "workflowSha256": "b6b8c87fc5f9615c193594c7a861a59e55022acfdb1dc9970c903af9fca22dee",
    },
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"prefetch refused: {message}")


def command(*argv: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, cwd=ROOT, text=True, capture_output=True, shell=False, check=False)


def version(*argv: str) -> str:
    result = command(*argv)
    require(result.returncode == 0, f"version command failed: {argv[0]}")
    return result.stdout.strip()


def main() -> None:
    require("HARNESS_TASK_PACKET" not in os.environ, "packet path leaked to prefetch child")
    require("HARNESS_WARM_SOURCE_ROOTS" not in os.environ, "warm-source roots leaked to prefetch child")
    require(sys.version_info[:3] == (3, 12, 14), f"CPython 3.12.14 required, got {sys.version.split()[0]}")
    require(version("node", "--version") == "v24.20.0", "Node.js 24.20.0 is required")
    require(version("npm", "--version") == "11.11.0", "npm 11.11.0 is required")
    require(version("uv", "--version").startswith("uv 0.12.7 "), "uv 0.12.7 is required")
    require(os.environ.get("npm_config_offline") == "true", "npm offline mode is required")
    require(os.environ.get("NEXT_TELEMETRY_DISABLED") == "1", "Next telemetry must be disabled")

    head = version("git", "rev-parse", "HEAD")
    require(command("git", "cat-file", "-e", f"{BASE}^{{commit}}").returncode == 0, "empty base commit is unavailable")
    if head != BASE:
        require(version("git", "rev-parse", "HEAD^1") == BASE, "implementation first parent is not the exact empty base")

    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    require(manifest["engines"] == {"node": "24.20.0", "npm": "11.11.0"}, "Node/npm engine lock drift")
    require(manifest["packageManager"] == "npm@11.11.0", "packageManager lock drift")
    require(manifest["dependencies"] == EXPECTED_DEPENDENCIES, "runtime dependency lock drift")
    require(manifest["devDependencies"] == EXPECTED_DEV_DEPENDENCIES, "development dependency lock drift")
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    root_lock = lock["packages"][""]
    require(root_lock["dependencies"] == EXPECTED_DEPENDENCIES, "package-lock runtime roots drift")
    require(root_lock["devDependencies"] == EXPECTED_DEV_DEPENDENCIES, "package-lock development roots drift")
    require(lock["lockfileVersion"] == 3, "package-lock v3 is required")

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    require(project["project"]["requires-python"] == "==3.12.*", "Python contract drift")
    require(project["project"]["dependencies"] == [], "worker must remain standard-library-only")
    uv_lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    require(uv_lock["package"] == [{"name": "planeon-harness-control-plane-worker", "version": "0.1.0", "source": {"editable": "."}}], "uv lock is not the one-package root closure")
    require(json.loads((ROOT / "apps/control-web/contracts.lock.json").read_text(encoding="utf-8")) == EXPECTED_LOCK, "predecessor lock drift")

    required = (
        "PORTING.yaml", "ci/run_make_target.py", "ci/run_packet_argv.py",
        "ci/targets/ctrl-001.json", "ci/verify-offline.sh",
        "apps/control-web/Containerfile", "workers/profile-compiler/Containerfile",
        "packages/db/migrations/001_foundation.sql", "prisma/schema.prisma",
        "deploy/helm/control-plane/Chart.yaml",
    )
    for relative in required:
        path = ROOT / relative
        require(path.is_file() and not path.is_symlink(), f"required regular source is missing: {relative}")

    install = command("npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund")
    if install.returncode:
        print(install.stdout, file=sys.stderr)
        print(install.stderr, file=sys.stderr)
        raise SystemExit("prefetch refused: offline npm closure is unavailable")
    print("prefetch passed: exact empty base, predecessor locks, toolchains, one-package worker, and offline npm closure are present")


if __name__ == "__main__":
    main()
