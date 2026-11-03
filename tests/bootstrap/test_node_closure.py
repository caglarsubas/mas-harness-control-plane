from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path("/opt/planeon/npm-cache/ctrl-006")
LOCK_SHA256 = "362ccf86489852256e36585ad1241c76a9c094d04cf8a35c9c2554e2f5e15cf7"
LOCK_BLOB = "d5efff4839064263b2b40b1734164903c1c91259"
# package.json as committed at 1de7c405329f4458970be0187838145b4da222d8.
MANIFEST_SHA256 = "f42c046ffd77f7b67f606cb454d1b340fe7901e13c97af4ec8b13161057fb6ef"
SWC = {("Darwin", "arm64"): "swc-darwin-arm64", ("Linux", "x86_64"): "swc-linux-x64-gnu"}


def git_blob(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def newer_than(root: Path, marker_ns: int) -> list[str]:
    found: list[str] = []
    for current, directories, files in os.walk(root, followlinks=False):
        for name in directories + files:
            path = Path(current) / name
            if path.lstat().st_mtime_ns > marker_ns:
                found.append(str(path.relative_to(root)))
    return found


class NodeClosureTests(unittest.TestCase):
    def test_offline_install_from_the_pinned_lock_and_read_only_cache(self) -> None:
        lock = (ROOT / "package-lock.json").read_bytes()
        self.assertEqual(hashlib.sha256(lock).hexdigest(), LOCK_SHA256)
        self.assertEqual(git_blob(lock), LOCK_BLOB)
        self.assertEqual(hashlib.sha256((ROOT / "package.json").read_bytes()).hexdigest(), MANIFEST_SHA256)

        temporary = Path(os.environ.get("TMPDIR") or tempfile.gettempdir())
        home = temporary / "npm-home"
        home.mkdir(parents=True, exist_ok=True)
        self.assertEqual(list(home.iterdir()), [])
        descriptor, name = tempfile.mkstemp(prefix="npm-closure-marker-", dir=temporary)
        os.close(descriptor)
        marker = Path(name)
        marker_ns = marker.stat().st_mtime_ns

        argv = [
            "npm", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--update-notifier=false",
            f"--cache={CACHE}", f"--logs-dir={temporary / 'npm-logs'}",
        ]
        environment = {"PATH": os.environ["PATH"], "TMPDIR": str(temporary), "HOME": str(home)}
        result = subprocess.run(argv, cwd=ROOT, env=environment, shell=False, check=False, capture_output=True, text=True, timeout=600)
        self.assertEqual(result.returncode, 0, result.stderr[-4000:])
        self.assertEqual(newer_than(CACHE, marker_ns), [])

        swc = SWC.get((platform.system(), platform.machine()))
        self.assertIsNotNone(swc, f"no Next SWC mapping for {platform.system()}/{platform.machine()}")
        self.assertTrue((ROOT / "node_modules/@next" / str(swc)).is_dir())


if __name__ == "__main__":
    unittest.main()
