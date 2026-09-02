"""CTRL-004 exact compiler and state-contract acceptance."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from fixture import (
    CATALOG_DIGEST,
    NOW,
    ORGANIZATION_A,
    WORKER_A,
    catalog_resources,
    compile_request,
    create_job,
    deterministic_outputs,
)
from planeon_harness_contracts.compiler import OUTPUT_NAMES
from planeon_harness_contracts.events import validate_event
from planeon_harness_contracts.validation import validate_catalog
from profile_compiler.compiler_adapter import (
    DependencyLockError,
    ExactCompiler,
    validate_dependency_lock,
)
from profile_compiler.domain import CompilationStore, CompilerWorker
from profile_compiler.postgres import CLAIM_SQL, FENCED_JOB_SQL


class ExactCompilerContractTests(unittest.TestCase):
    def test_closed_dependency_lock_and_runner_environment_are_admitted(self) -> None:
        lock = validate_dependency_lock()
        self.assertEqual(lock["contracts"]["wheelSha256"], "53500a690c8b7614e0cb6ea1e4d78e0831b94a458523e558fedfeb13428bb97b")
        self.assertEqual(lock["network"], "DENY_ALL_OUTBOUND")
        self.assertFalse(lock["runtimeDownloads"])

        with tempfile.TemporaryDirectory() as directory:
            altered = copy.deepcopy(lock)
            altered["network"] = "CONNECTED"
            lock_path = Path(directory) / "dependencies.lock.json"
            lock_path.write_text(json.dumps(altered), encoding="utf-8")
            with self.assertRaisesRegex(DependencyLockError, "DEPENDENCY_POLICY_REFUSED"):
                validate_dependency_lock(lock_path)

    def test_clean_room_catalog_and_exact_compiler_emit_six_deterministic_outputs(self) -> None:
        resources = catalog_resources()
        self.assertTrue(validate_catalog(resources).accepted)
        compiler = ExactCompiler()
        first = compiler.compile(compile_request(), resources, CATALOG_DIGEST)
        second = compiler.compile(compile_request(), tuple(reversed(resources)), CATALOG_DIGEST)
        self.assertEqual(tuple(first), OUTPUT_NAMES)
        self.assertEqual(first, second)
        self.assertEqual(first["profile.sha256"].decode("ascii").strip(), self._digest(first["profile.json"]))
        document = json.loads(first["profile.json"])
        self.assertEqual(document["profile"]["spec"]["state"], "PLANNED")
        self.assertEqual(document["profile"]["spec"]["selectedHarnessIds"], ["runtime.infrastructure"])
        self.assertEqual(document["profile"]["spec"]["selectedProviderIds"], [])

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            compiler.write(target, first)
            self.assertEqual(tuple(sorted(path.name for path in target.iterdir())), tuple(sorted(OUTPUT_NAMES)))

    def test_worker_transitions_and_events_are_canonical(self) -> None:
        store = CompilationStore()
        operation, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        self.assertIsNotNone(claimed)
        assert claimed is not None and claimed.lease_token is not None
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "RUNNING")
        revision = store.succeed(
            ORGANIZATION_A,
            job.id,
            WORKER_A,
            claimed.lease_token,
            NOW + 1,
            deterministic_outputs(),
        )
        self.assertEqual(revision.profile_id, "profile.fixture")
        completed = store.operations[(ORGANIZATION_A, operation.id)]
        self.assertEqual(completed.state, "SUCCEEDED")
        self.assertEqual(len(store.outbox), 2)
        for record in store.outbox:
            self.assertEqual(validate_event(record.event), ())
            serialized = json.dumps(record.event, sort_keys=True, separators=(",", ":"))
            for forbidden in ("password", "secret", "prompt", "credential", "rawPayload"):
                self.assertNotIn(forbidden, serialized)

        self.assertIsNone(store.claim(ORGANIZATION_A, WORKER_A, NOW + 2))
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "SUCCEEDED")

    def test_one_shot_worker_has_no_listener_or_network_contract(self) -> None:
        store = CompilationStore()
        _, job = create_job(store)
        compiler = type(
            "Compiler",
            (),
            {
                "wheel_digest": property(lambda _self: f"sha256:{'5' * 64}"),
                "compile": lambda _self, _request, _resources, _digest: deterministic_outputs(),
            },
        )()
        self.assertEqual(CompilerWorker(store, compiler).run_once(ORGANIZATION_A, WORKER_A, NOW), "SUCCEEDED")
        self.assertEqual(store.jobs[(ORGANIZATION_A, job.id)].state, "SUCCEEDED")
        self.assertIn("FOR UPDATE SKIP LOCKED", CLAIM_SQL)
        self.assertIn("lease_token = %s", CLAIM_SQL)
        self.assertIn("lease_expires_at > %s", FENCED_JOB_SQL)
        self.assertNotIn("http", CLAIM_SQL.lower())

    @staticmethod
    def _digest(value: bytes) -> str:
        import hashlib

        return f"sha256:{hashlib.sha256(value).hexdigest()}"


if __name__ == "__main__":
    unittest.main()
