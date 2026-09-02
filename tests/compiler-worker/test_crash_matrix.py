"""CTRL-004 lease, retry, duplicate, and crash-boundary matrix."""

from __future__ import annotations

import copy
import unittest

from fixture import (
    FakeCompiler,
    NOW,
    ORGANIZATION_A,
    ORGANIZATION_B,
    WORKER_A,
    WORKER_B,
    create_job,
    deterministic_outputs,
)
from profile_compiler.domain import CompilationStore, CompilerWorker, StoreError


class CrashMatrixTests(unittest.TestCase):
    def test_worker_dead_letters_malformed_output_and_wheel_mismatch(self) -> None:
        malformed_store = CompilationStore()
        create_job(malformed_store)
        malformed = dict(deterministic_outputs())
        malformed["profile.sha256"] = b"sha256:wrong\n"
        self.assertEqual(
            CompilerWorker(malformed_store, FakeCompiler(malformed)).run_once(ORGANIZATION_A, WORKER_A, NOW),
            "DEAD_LETTERED",
        )
        malformed_operation = next(iter(malformed_store.operations.values()))
        self.assertEqual(malformed_operation.failure_reason, "PROFILE_DIGEST_REFUSED")
        self.assertEqual(malformed_store.profiles, {})

        mismatch_store = CompilationStore()
        _, mismatch_job = create_job(mismatch_store)
        mismatch_compiler = FakeCompiler(deterministic_outputs(), wheel_digest=f"sha256:{'9' * 64}")
        self.assertEqual(
            CompilerWorker(mismatch_store, mismatch_compiler).run_once(ORGANIZATION_A, WORKER_A, NOW),
            "DEAD_LETTERED",
        )
        self.assertEqual(mismatch_store.jobs[(ORGANIZATION_A, mismatch_job.id)].failure_reason, "COMPILER_WHEEL_MISMATCH")

    def test_worker_applies_retry_schedule_and_exhausts_without_unbounded_loop(self) -> None:
        store = CompilationStore()
        _, job = create_job(store)
        compiler = FakeCompiler(deterministic_outputs(), reason_code="STORE_TEMPORARY", retryable=True)
        worker = CompilerWorker(store, compiler)
        self.assertEqual(worker.run_once(ORGANIZATION_A, WORKER_A, NOW), "RETRY_WAIT")
        self.assertEqual(worker.run_once(ORGANIZATION_A, WORKER_A, NOW + 1), "IDLE_NO_JOB")
        self.assertEqual(worker.run_once(ORGANIZATION_A, WORKER_A, NOW + 6), "RETRY_WAIT")
        self.assertEqual(worker.run_once(ORGANIZATION_A, WORKER_A, NOW + 37), "DEAD_LETTERED")
        self.assertEqual(store.jobs[(ORGANIZATION_A, job.id)].attempt, 3)
        self.assertEqual(compiler.calls, 3)

    def test_claim_order_exclusion_extension_expiry_reclaim_and_stale_fence(self) -> None:
        store = CompilationStore()
        _, first = create_job(store, now=NOW)
        _, second = create_job(store, now=NOW + 1)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW + 1, lease_seconds=10)
        self.assertEqual(claimed.id, first.id)
        concurrently_claimed = store.claim(ORGANIZATION_A, WORKER_B, NOW + 1, lease_seconds=10)
        self.assertEqual(concurrently_claimed.id, second.id)
        assert claimed.lease_token is not None
        extended = store.extend(ORGANIZATION_A, first.id, WORKER_A, claimed.lease_token, NOW + 2, lease_seconds=20)
        self.assertEqual(extended.lease_expires_at, NOW + 22)
        reclaimed = store.claim(ORGANIZATION_A, WORKER_B, NOW + 22, lease_seconds=10)
        self.assertEqual(reclaimed.id, first.id)
        self.assertEqual(reclaimed.attempt, 2)
        with self.assertRaisesRegex(StoreError, "LEASE_FENCE_REFUSED"):
            store.succeed(ORGANIZATION_A, first.id, WORKER_A, claimed.lease_token, NOW + 23, deterministic_outputs())

    def test_retry_delays_three_attempt_limit_and_nonretryable_failure(self) -> None:
        store = CompilationStore()
        operation, job = create_job(store)
        first = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert first is not None and first.lease_token is not None
        retry_one = store.retry(ORGANIZATION_A, job.id, WORKER_A, first.lease_token, NOW + 1, "STORE_TEMPORARY")
        self.assertEqual(retry_one.available_at, NOW + 6)
        second = store.claim(ORGANIZATION_A, WORKER_A, NOW + 6)
        assert second is not None and second.lease_token is not None
        retry_two = store.retry(ORGANIZATION_A, job.id, WORKER_A, second.lease_token, NOW + 7, "STORE_TEMPORARY")
        self.assertEqual(retry_two.available_at, NOW + 37)
        third = store.claim(ORGANIZATION_A, WORKER_A, NOW + 37)
        assert third is not None and third.lease_token is not None
        exhausted = store.retry(ORGANIZATION_A, job.id, WORKER_A, third.lease_token, NOW + 38, "STORE_TEMPORARY")
        self.assertEqual(exhausted.state, "DEAD_LETTERED")
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "FAILED")
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].failure_reason, "RETRY_EXHAUSTED")

        other = CompilationStore()
        other_operation, other_job = create_job(other)
        claimed = other.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None and claimed.lease_token is not None
        failed = other.fail(ORGANIZATION_A, other_job.id, WORKER_A, claimed.lease_token, NOW + 1, "COMPILER_INPUT_REFUSED", retryable=False)
        self.assertEqual(failed.state, "FAILED")
        self.assertFalse(failed.failure_retryable)
        self.assertNotIn("input", repr(failed.result_refs).lower())
        self.assertEqual(other.operations[(ORGANIZATION_A, other_operation.id)], failed)

    def test_atomic_failpoints_before_create_claim_retry_failure_and_result_commit(self) -> None:
        create_store = CompilationStore()
        create_store.inject_failure("create.before_commit")
        with self.assertRaisesRegex(StoreError, "INJECTED_ATOMIC_FAILURE"):
            create_job(create_store)
        self.assertEqual((create_store.operations, create_store.jobs, create_store.audit), ({}, {}, []))

        claim_store = CompilationStore()
        operation, job = create_job(claim_store)
        claim_store.inject_failure("claim.before_commit")
        with self.assertRaisesRegex(StoreError, "INJECTED_ATOMIC_FAILURE"):
            claim_store.claim(ORGANIZATION_A, WORKER_A, NOW)
        self.assertEqual(claim_store.jobs[(ORGANIZATION_A, job.id)].state, "QUEUED")
        self.assertEqual(claim_store.operations[(ORGANIZATION_A, operation.id)].state, "PENDING")
        self.assertEqual(len(claim_store.outbox), 0)

        for failpoint, action in (
            ("retry.before_commit", "retry"),
            ("failure.before_commit", "fail"),
            ("result.before_commit", "succeed"),
        ):
            store = CompilationStore()
            operation, job = create_job(store)
            claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
            assert claimed is not None and claimed.lease_token is not None
            before_audit = len(store.audit)
            before_outbox = len(store.outbox)
            store.inject_failure(failpoint)
            with self.assertRaisesRegex(StoreError, "INJECTED_ATOMIC_FAILURE"):
                if action == "retry":
                    store.retry(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, "STORE_TEMPORARY")
                elif action == "fail":
                    store.fail(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, "COMPILER_REFUSED", retryable=False)
                else:
                    store.succeed(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, deterministic_outputs())
            self.assertEqual(store.jobs[(ORGANIZATION_A, job.id)].state, "LEASED")
            self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "RUNNING")
            self.assertEqual(len(store.audit), before_audit)
            self.assertEqual(len(store.outbox), before_outbox)
            self.assertEqual(store.profiles, {})

    def test_result_replay_and_binding_are_exactly_once(self) -> None:
        store = CompilationStore()
        operation, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None and claimed.lease_token is not None
        first = store.succeed(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, deterministic_outputs())
        counts = (len(store.profiles), len(store.profile_bindings), len(store.outbox), len(store.audit))
        second = store.succeed(ORGANIZATION_A, job.id, WORKER_A, "stale-token", NOW + 2, deterministic_outputs())
        self.assertEqual(first, second)
        self.assertEqual(counts, (len(store.profiles), len(store.profile_bindings), len(store.outbox), len(store.audit)))
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "SUCCEEDED")

    def test_malformed_outputs_fail_closed_without_visible_profile(self) -> None:
        store = CompilationStore()
        operation, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None and claimed.lease_token is not None
        malformed = dict(deterministic_outputs())
        malformed["profile.sha256"] = b"sha256:wrong\n"
        with self.assertRaisesRegex(StoreError, "PROFILE_DIGEST_REFUSED"):
            store.succeed(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, malformed)
        self.assertEqual(store.profiles, {})
        self.assertEqual(store.operations[(ORGANIZATION_A, operation.id)].state, "RUNNING")

    def test_outbox_redelivery_uses_identical_event_and_ack_is_append_only(self) -> None:
        store = CompilationStore()
        _, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None and claimed.lease_token is not None
        store.succeed(ORGANIZATION_A, job.id, WORKER_A, claimed.lease_token, NOW + 1, deterministic_outputs())
        observed: list[dict[str, object]] = []
        with self.assertRaisesRegex(StoreError, "INJECTED_AFTER_DELIVERY"):
            store.deliver_next(lambda event: observed.append(copy.deepcopy(event)), crash_after_delivery=True)
        delivered = store.deliver_next(lambda event: observed.append(copy.deepcopy(event)))
        self.assertEqual(observed[0], observed[1])
        self.assertEqual(delivered, observed[0]["id"])
        self.assertEqual(len(store.delivery_receipts), 1)
        self.assertEqual(sum(1 for item in store.audit if item["type"] == "outbox.published.v1"), 1)

    def test_inbox_source_partition_sequence_duplicate_and_atomicity(self) -> None:
        store = CompilationStore()
        _, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None
        event = copy.deepcopy(store.outbox[0].event)
        allowed = {"source.control-worker"}
        self.assertTrue(store.accept_event("source.control-worker", allowed, event))
        self.assertFalse(store.accept_event("source.control-worker", allowed, copy.deepcopy(event)))
        conflict = copy.deepcopy(event)
        conflict["data"]["reasonCode"] = "ALTERED"
        with self.assertRaisesRegex(StoreError, "EVENT_ID_CONFLICT"):
            store.accept_event("source.control-worker", allowed, conflict)
        with self.assertRaisesRegex(StoreError, "EVENT_SOURCE_REFUSED"):
            store.accept_event("source.unknown", allowed, event)
        wrong_partition = copy.deepcopy(event)
        wrong_partition["id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        wrong_partition["partitionkey"] = "tenant.other"
        with self.assertRaisesRegex(StoreError, "EVENT_PARTITION_REFUSED"):
            store.accept_event("source.control-worker", allowed, wrong_partition)
        older = copy.deepcopy(event)
        older["id"] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        with self.assertRaisesRegex(StoreError, "EVENT_SEQUENCE_REFUSED"):
            store.accept_event("source.control-worker", allowed, older)

        atomic = CompilationStore()
        atomic.inject_failure("inbox.before_commit")
        with self.assertRaisesRegex(StoreError, "INJECTED_ATOMIC_FAILURE"):
            atomic.accept_event("source.control-worker", allowed, event)
        self.assertEqual((atomic.inbox, atomic.inbox_sequences, atomic.audit), ({}, {}, []))

    def test_cross_tenant_job_and_lease_are_indistinguishable(self) -> None:
        store = CompilationStore()
        _, job = create_job(store)
        claimed = store.claim(ORGANIZATION_A, WORKER_A, NOW)
        assert claimed is not None and claimed.lease_token is not None
        with self.assertRaisesRegex(StoreError, "JOB_NOT_FOUND"):
            store.extend(ORGANIZATION_B, job.id, WORKER_A, claimed.lease_token, NOW + 1)


if __name__ == "__main__":
    unittest.main()
