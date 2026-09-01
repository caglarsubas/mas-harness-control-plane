from __future__ import annotations

import importlib.util
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "workers/profile-compiler/worker.py"
SPEC = importlib.util.spec_from_file_location("profile_compiler_worker", PATH)
assert SPEC and SPEC.loader
worker = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def invoke(self, argv: list[str]) -> tuple[int, dict[str, object]]:
        output = io.StringIO()
        with redirect_stdout(output):
            code = worker.main(argv)
        return code, json.loads(output.getvalue())

    def test_health_is_ready_only_when_both_injected_dependencies_are_ready(self) -> None:
        code, body = self.invoke(["--health-check", "--contracts-state", "READY", "--store-state", "READY"])
        self.assertEqual(code, 0)
        self.assertEqual(body["state"], "READY")
        code, body = self.invoke(["--health-check", "--contracts-state", "READY", "--store-state", "NOT_READY"])
        self.assertEqual(code, 3)
        self.assertEqual(body["state"], "NOT_READY")

    def test_run_once_is_inert_and_fails_closed(self) -> None:
        code, body = self.invoke(["--run-once", "--contracts-state", "READY", "--store-state", "READY"])
        self.assertEqual(code, 0)
        self.assertEqual(body["outcome"], "IDLE_BOOTSTRAP")
        self.assertNotIn("job", json.dumps(body).casefold())
        code, body = self.invoke(["--run-once", "--contracts-state", "NOT_READY", "--store-state", "READY"])
        self.assertEqual(code, 3)
        self.assertEqual(body["code"], "WORKER_DEPENDENCY_NOT_READY")

    def test_worker_has_no_network_polling_or_subprocess_surface(self) -> None:
        source = PATH.read_text(encoding="utf-8")
        for forbidden in ("import socket", "import subprocess", "import urllib", "requests", "sleep(", "while True"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
