from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "ci/run_make_target.py"
SPEC = importlib.util.spec_from_file_location("run_make_target", PATH)
assert SPEC and SPEC.loader
dispatch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatch
SPEC.loader.exec_module(dispatch)

CHILD_CHECK = "import os, sys; sys.exit(0 if os.environ.get('NEXT_TELEMETRY_DISABLED') == '1' else 3)"


def descriptor() -> dict[str, object]:
    return {
        "packetId": "CTRL-TRANSPORT-001",
        "schemaVersion": "harness.planeon.ai/make-target-descriptor/v1alpha1",
        "targets": [
            {"acceptedVariables": {}, "argvTemplate": [["python3", "-I", "-B", "-c", CHILD_CHECK]], "name": "child-env"}
        ],
    }


class DispatchChildEnvironmentTests(unittest.TestCase):
    def run_fixture(self) -> int:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ctrl-transport-001.json").write_text(json.dumps(descriptor()), encoding="utf-8")
            return dispatch.dispatch("child-env", {}, root)

    def test_dispatched_child_sees_telemetry_disabled_when_the_parent_lacks_it(self) -> None:
        with mock.patch.dict(os.environ, clear=False):
            os.environ.pop("NEXT_TELEMETRY_DISABLED", None)
            self.assertEqual(self.run_fixture(), 0)

    def test_parent_environment_is_not_mutated(self) -> None:
        with mock.patch.dict(os.environ, clear=False):
            os.environ.pop("NEXT_TELEMETRY_DISABLED", None)
            before = dict(os.environ)
            self.assertEqual(self.run_fixture(), 0)
            self.assertEqual(dict(os.environ), before)
            self.assertNotIn("NEXT_TELEMETRY_DISABLED", os.environ)


if __name__ == "__main__":
    unittest.main()
