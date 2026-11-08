from __future__ import annotations

import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "ci/run_packet_argv.py"
SPEC = importlib.util.spec_from_file_location("run_packet_argv", PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

LF_TEXT = 'id: FIXTURE-001\nobjective: "raw byte digest fixture"\noffline: [["make", "fixture"]]\n'
LF_BYTES = LF_TEXT.encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PacketRawDigestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, name: str, data: bytes) -> Path:
        path = self.root / name
        path.write_bytes(data)
        return path

    def test_lf_packet_digest_is_raw_sha256(self) -> None:
        path = self.write("lf.yaml", LF_BYTES)
        text, digest = runner.read_packet_text(path)
        self.assertEqual(text, LF_TEXT)
        self.assertEqual(digest, sha256(path.read_bytes()))

    def test_crlf_and_bare_cr_packets_are_refused(self) -> None:
        crlf = LF_BYTES.replace(b"\n", b"\r\n")
        first = LF_BYTES.index(b"\n")
        bare_cr = LF_BYTES[:first] + b"\r" + LF_BYTES[first + 1 :]
        self.assertEqual(len(bare_cr), len(LF_BYTES))
        for name, data in (("crlf.yaml", crlf), ("bare-cr.yaml", bare_cr)):
            with self.subTest(name=name):
                self.assertNotEqual(sha256(data), sha256(LF_BYTES))
                path = self.write(name, data)
                with self.assertRaises(runner.PacketTransportError):
                    runner.read_packet_text(path)

    def test_byte_order_mark_and_invalid_utf8_are_refused(self) -> None:
        bom = b"\xef\xbb\xbf" + LF_BYTES
        invalid = LF_BYTES[:4] + b"\xff" + LF_BYTES[4:]
        for name, data in (("bom.yaml", bom), ("invalid.yaml", invalid)):
            with self.subTest(name=name):
                path = self.write(name, data)
                with self.assertRaises(runner.PacketTransportError):
                    runner.read_packet_text(path)

    def test_newline_only_mutation_fails_digest_verification(self) -> None:
        path = self.write("packet.yaml", LF_BYTES)
        digest = sha256(LF_BYTES)
        runner.verify_packet_digest(path, digest)
        path.write_bytes(LF_BYTES.replace(b"\n", b"\r\n"))
        with self.assertRaises(runner.PacketTransportError):
            runner.verify_packet_digest(path, digest)
        path.write_bytes(LF_BYTES + b"\n")
        with self.assertRaises(runner.PacketTransportError):
            runner.verify_packet_digest(path, digest)


if __name__ == "__main__":
    unittest.main()
