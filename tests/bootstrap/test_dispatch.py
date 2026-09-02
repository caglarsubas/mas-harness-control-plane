from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "ci/run_make_target.py"
SPEC = importlib.util.spec_from_file_location("run_make_target", PATH)
assert SPEC and SPEC.loader
dispatch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatch
SPEC.loader.exec_module(dispatch)


def descriptor(packet: str = "CTRL-001", executable: str = "python3") -> dict[str, object]:
    return {
        "packetId": packet,
        "schemaVersion": "harness.planeon.ai/make-target-descriptor/v1alpha1",
        "targets": [
            {"acceptedVariables": {}, "argvTemplate": [[executable, "-c", "raise SystemExit(0)"]], "name": "fixture"}
        ],
    }


class DispatchTests(unittest.TestCase):
    def write(self, directory: Path, name: str, value: object) -> None:
        (directory / name).write_text(json.dumps(value), encoding="utf-8")

    def test_closed_descriptor_loads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write(root, "ctrl-001.json", descriptor())
            rules = dispatch.load_rules(root)
            self.assertEqual(len(rules), 1)
            self.assertEqual(rules[0].packet_id, "CTRL-001")

    def test_owner_filename_shell_duplicate_and_unknown_fields_fail(self) -> None:
        vectors: list[tuple[str, str, object]] = [
            ("wrong.json", "owner", descriptor()),
            ("ctrl-001.json", "shell", descriptor(executable="sh")),
            ("ctrl-001.json", "unknown", {**descriptor(), "extra": True}),
        ]
        for filename, _label, value in vectors:
            with self.subTest(label=_label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                self.write(root, filename, value)
                with self.assertRaises(dispatch.DescriptorError):
                    dispatch.load_rules(root)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ctrl-001.json").write_text('{"packetId":"CTRL-001","packetId":"CTRL-001"}', encoding="utf-8")
            with self.assertRaises(dispatch.DescriptorError):
                dispatch.load_rules(root)

    def test_zero_handler_and_undeclared_make_variable_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write(root, "ctrl-001.json", descriptor())
            with self.assertRaises(dispatch.DescriptorError):
                dispatch.dispatch("unknown", {}, root)
        with self.assertRaises(dispatch.DescriptorError):
            dispatch.supplied_variables({"MAKEOVERRIDES": "UNDECLARED=value"})


if __name__ == "__main__":
    unittest.main()
