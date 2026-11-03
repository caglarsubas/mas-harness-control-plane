from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCAN = ROOT / "ci/zero_bill_scan.py"
SCANNED = (
    "package.json",
    "PORTING.yaml",
    "apps/control-web/Containerfile",
    "workers/profile-compiler/Containerfile",
)
SCANNED_TREES = ("apps/control-web/src", "deploy/helm/control-plane")


def scan(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-I", "-B", str(SCAN), str(root)],
        capture_output=True, text=True, shell=False, check=False,
    )


class NoWorkflowTests(unittest.TestCase):
    def test_repository_holds_no_hosted_workflow_file(self) -> None:
        workflows = ROOT / ".github/workflows"
        self.assertFalse(workflows.is_symlink())
        self.assertEqual([path for path in workflows.rglob("*") if path.is_file() or path.is_symlink()] if workflows.exists() else [], [])

    def test_zero_bill_scan_passes_on_the_repository_root(self) -> None:
        result = scan(ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("zero-bill scan passed", result.stdout)

    def layout(self, root: Path) -> None:
        for relative in SCANNED:
            (root / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, root / relative)
        for relative in SCANNED_TREES:
            shutil.copytree(ROOT / relative, root / relative, symlinks=True)

    def assert_refused(self, root: Path) -> None:
        result = scan(root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hosted workflow files are forbidden", result.stderr)

    def test_zero_bill_scan_refuses_a_synthetic_workflow_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.layout(root)
            self.assertEqual(scan(root).returncode, 0)

            workflow = root / ".github/workflows/verify.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("on: pull_request\n", encoding="utf-8")
            self.assert_refused(root)

    def test_zero_bill_scan_refuses_a_workflow_symlink_or_file_in_place_of_the_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.layout(root)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/workflows/verify.yml").symlink_to(root / "package.json")
            self.assert_refused(root)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.layout(root)
            (root / ".github").mkdir()
            (root / ".github/workflows").write_text("on: pull_request\n", encoding="utf-8")
            self.assert_refused(root)


if __name__ == "__main__":
    unittest.main()
