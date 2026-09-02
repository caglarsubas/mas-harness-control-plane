#!/usr/bin/env python3
"""No-listener CTRL-004 profile compiler worker entry point."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

WORKER_ROOT = Path(__file__).resolve().parent
if str(WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKER_ROOT))

from profile_compiler.compiler_adapter import DependencyLockError, validate_dependency_lock

SCHEMA_VERSION = "planeon.control.compiler-worker/v1alpha1"
STATES = ("READY", "NOT_READY")


@dataclass(frozen=True, slots=True)
class WorkerDependencies:
    contracts_lock: str
    owned_store: str

    @property
    def ready(self) -> bool:
        return self.contracts_lock == "READY" and self.owned_store == "READY"


def health(dependencies: WorkerDependencies) -> dict[str, object]:
    return {
        "dependencies": [
            {
                "name": "contract-lock",
                "reasonCode": "INJECTED_READY" if dependencies.contracts_lock == "READY" else "INJECTED_NOT_READY",
                "required": True,
                "state": dependencies.contracts_lock,
            },
            {
                "name": "owned-store",
                "reasonCode": "INJECTED_READY" if dependencies.owned_store == "READY" else "INJECTED_NOT_READY",
                "required": True,
                "state": dependencies.owned_store,
            },
        ],
        "schemaVersion": SCHEMA_VERSION,
        "service": "profile-compiler-worker",
        "state": "READY" if dependencies.ready else "NOT_READY",
    }


def run_once(dependencies: WorkerDependencies) -> dict[str, object]:
    if not dependencies.ready:
        raise RuntimeError("WORKER_DEPENDENCY_NOT_READY")
    return {
        "outcome": "IDLE_BOOTSTRAP",
        "schemaVersion": SCHEMA_VERSION,
        "service": "profile-compiler-worker",
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--health-check", action="store_true")
    action.add_argument("--run-once", action="store_true")
    parser.add_argument("--contracts-state", choices=STATES, required=True)
    parser.add_argument("--store-state", choices=STATES, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    dependencies = WorkerDependencies(args.contracts_state, args.store_state)
    if args.health_check:
        result = health(dependencies)
        if dependencies.ready:
            try:
                validate_dependency_lock(Path(__file__).with_name("dependencies.lock.json"))
            except DependencyLockError:
                result = {**result, "state": "NOT_READY", "reasonCode": "DEPENDENCY_LOCK_REFUSED"}
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0 if result["state"] == "READY" else 3
    try:
        result = run_once(dependencies)
    except RuntimeError:
        print(
            json.dumps(
                {
                    "code": "WORKER_DEPENDENCY_NOT_READY",
                    "message": "Worker refused.",
                    "schemaVersion": SCHEMA_VERSION,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        return 3
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
