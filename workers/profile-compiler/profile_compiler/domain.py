"""Lease-fenced in-memory parity model for durable profile compilation."""

from __future__ import annotations

import copy
import hashlib
import json
import re
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any, Callable, Mapping, Protocol, Sequence

from .compiler_adapter import CompilerInvocationError, ExactCompiler

OUTPUT_NAMES = (
    "profile.json",
    "bom.json",
    "install-plan.json",
    "evidence-plan.json",
    "explanation.md",
    "profile.sha256",
)
JOB_STATES = ("QUEUED", "LEASED", "RETRY_WAIT", "SUCCEEDED", "DEAD_LETTERED")
OPERATION_STATES = ("PENDING", "RUNNING", "CANCELLING", "SUCCEEDED", "FAILED", "CANCELLED")
RETRY_DELAYS = (5, 30)
MAX_ATTEMPTS = 3
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
REASON = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$")


class StoreError(RuntimeError):
    """Stable refusal from the compilation state model."""

    def __init__(self, reason_code: str) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code


@dataclass(frozen=True, slots=True)
class Operation:
    id: str
    organization_id: str
    state: str
    version: int
    demand_id: str
    demand_revision: int
    demand_digest: str
    actor_id: str
    idempotency_key_digest: str
    correlation_id: str
    requested_at: int
    updated_at: int
    result_refs: tuple[Mapping[str, str], ...] = ()
    failure_reason: str | None = None
    failure_retryable: bool | None = None


@dataclass(frozen=True, slots=True)
class CompilationJob:
    id: str
    organization_id: str
    operation_id: str
    state: str
    demand_id: str
    demand_revision: int
    demand_digest: str
    input_digest: str
    catalog_digest: str
    compiler_wheel_digest: str
    compile_request: Mapping[str, Any]
    catalog_resources: tuple[Mapping[str, Any], ...]
    attempt: int
    available_at: int
    created_at: int
    lease_owner: str | None = None
    lease_token: str | None = None
    claimed_at: int | None = None
    lease_expires_at: int | None = None
    failure_reason: str | None = None
    result_key: str | None = None


@dataclass(frozen=True, slots=True)
class ProfileRevision:
    key: str
    organization_id: str
    profile_id: str
    revision: int
    demand_id: str
    demand_revision: int
    demand_digest: str
    compiler_wheel_digest: str
    catalog_digest: str
    outputs: Mapping[str, bytes]
    output_digests: Mapping[str, str]
    created_at: int


@dataclass(frozen=True, slots=True)
class OutboxRecord:
    event: Mapping[str, Any]
    payload_digest: str


class Compiler(Protocol):
    @property
    def wheel_digest(self) -> str: ...

    def compile(
        self,
        request: Mapping[str, Any],
        resources: Sequence[Mapping[str, Any]],
        catalog_digest: str,
    ) -> Mapping[str, bytes]: ...


def _digest(data: bytes | str) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _canonical(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _time(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tenant_id(organization_id: str) -> str:
    return f"tenant.{organization_id.replace('-', '')}"


def _uuid4() -> str:
    return str(uuid.uuid4())


def _stable(prefix: str) -> str:
    return f"{prefix}.{uuid.uuid4().hex}"


class CompilationStore:
    """Atomic parity store used to prove durable semantics without claiming live PostgreSQL."""

    def __init__(self) -> None:
        self.operations: dict[tuple[str, str], Operation] = {}
        self.jobs: dict[tuple[str, str], CompilationJob] = {}
        self.profiles: dict[str, ProfileRevision] = {}
        self.profile_bindings: dict[tuple[str, str, int, str, str, str], str] = {}
        self.outbox: list[OutboxRecord] = []
        self.audit: list[Mapping[str, Any]] = []
        self.inbox: dict[tuple[str, str], Mapping[str, Any]] = {}
        self.inbox_sequences: dict[tuple[str, str], int] = {}
        self.delivery_receipts: set[str] = set()
        self._failpoints: set[str] = set()

    def inject_failure(self, name: str) -> None:
        self._failpoints.add(name)

    def _fail(self, name: str) -> None:
        if name in self._failpoints:
            self._failpoints.remove(name)
            raise StoreError("INJECTED_ATOMIC_FAILURE")

    def create_job(
        self,
        *,
        organization_id: str,
        demand_id: str,
        demand_revision: int,
        demand_digest: str,
        input_digest: str,
        catalog_digest: str,
        compiler_wheel_digest: str,
        compile_request: Mapping[str, Any],
        catalog_resources: Sequence[Mapping[str, Any]],
        actor_id: str,
        idempotency_key_digest: str,
        now: int,
    ) -> tuple[Operation, CompilationJob]:
        if not all(SHA256.fullmatch(value) for value in (demand_digest, input_digest, catalog_digest, compiler_wheel_digest, idempotency_key_digest)):
            raise StoreError("DIGEST_REFUSED")
        operation = Operation(
            id=_stable("operation"), organization_id=organization_id, state="PENDING", version=1,
            demand_id=demand_id, demand_revision=demand_revision, demand_digest=demand_digest,
            actor_id=actor_id, idempotency_key_digest=idempotency_key_digest,
            correlation_id=_uuid4(), requested_at=now, updated_at=now,
        )
        job = CompilationJob(
            id=_stable("job"), organization_id=organization_id, operation_id=operation.id,
            state="QUEUED", demand_id=demand_id, demand_revision=demand_revision,
            demand_digest=demand_digest, input_digest=input_digest, catalog_digest=catalog_digest,
            compiler_wheel_digest=compiler_wheel_digest, compile_request=copy.deepcopy(compile_request),
            catalog_resources=tuple(copy.deepcopy(tuple(catalog_resources))), attempt=0,
            available_at=now, created_at=now,
        )
        self._fail("create.before_commit")
        self.operations[(organization_id, operation.id)] = operation
        self.jobs[(organization_id, job.id)] = job
        self.audit.append({"type": "profile.compilation.requested.v1", "aggregateId": operation.id})
        return operation, job

    def claim(self, organization_id: str, worker_id: str, now: int, lease_seconds: int = 60) -> CompilationJob | None:
        eligible = [
            job for (tenant, _), job in self.jobs.items()
            if tenant == organization_id and (
                (job.state in {"QUEUED", "RETRY_WAIT"} and job.available_at <= now)
                or (job.state == "LEASED" and job.lease_expires_at is not None and job.lease_expires_at <= now)
            )
        ]
        if not eligible:
            return None
        current = min(eligible, key=lambda job: (job.available_at, job.created_at, job.id))
        changed = replace(
            current, state="LEASED", attempt=current.attempt + 1, lease_owner=worker_id,
            lease_token=_uuid4(), claimed_at=now, lease_expires_at=now + lease_seconds,
            failure_reason=None,
        )
        operation = self.operations[(organization_id, current.operation_id)]
        operation_changed = operation
        event_record: OutboxRecord | None = None
        if operation.state == "PENDING":
            operation_changed = replace(operation, state="RUNNING", version=operation.version + 1, updated_at=now)
            event_record = self._event(operation_changed, "PENDING", "COMPILATION_STARTED")
        elif operation.state != "RUNNING":
            raise StoreError("OPERATION_TERMINAL")
        self._fail("claim.before_commit")
        self.jobs[(organization_id, current.id)] = changed
        self.operations[(organization_id, operation.id)] = operation_changed
        if event_record is not None:
            self.outbox.append(event_record)
            self.audit.append({"type": "harness.operation.state.changed.v1", "aggregateId": operation.id})
        return changed

    def extend(self, organization_id: str, job_id: str, worker_id: str, lease_token: str, now: int, lease_seconds: int = 60) -> CompilationJob:
        current = self._leased(organization_id, job_id, worker_id, lease_token, now)
        changed = replace(current, lease_expires_at=now + lease_seconds)
        self._fail("lease.before_commit")
        self.jobs[(organization_id, job_id)] = changed
        return changed

    def retry(self, organization_id: str, job_id: str, worker_id: str, lease_token: str, now: int, reason_code: str) -> CompilationJob:
        current = self._leased(organization_id, job_id, worker_id, lease_token, now)
        if not REASON.fullmatch(reason_code):
            raise StoreError("REASON_CODE_REFUSED")
        if current.attempt >= MAX_ATTEMPTS:
            self.fail(organization_id, job_id, worker_id, lease_token, now, "RETRY_EXHAUSTED", retryable=False)
            return self.jobs[(organization_id, job_id)]
        delay = RETRY_DELAYS[current.attempt - 1]
        changed = replace(
            current, state="RETRY_WAIT", available_at=now + delay, lease_owner=None,
            lease_token=None, claimed_at=None, lease_expires_at=None, failure_reason=reason_code,
        )
        self._fail("retry.before_commit")
        self.jobs[(organization_id, job_id)] = changed
        return changed

    def fail(
        self,
        organization_id: str,
        job_id: str,
        worker_id: str,
        lease_token: str,
        now: int,
        reason_code: str,
        *,
        retryable: bool,
    ) -> Operation:
        current = self._leased(organization_id, job_id, worker_id, lease_token, now)
        if not REASON.fullmatch(reason_code):
            raise StoreError("REASON_CODE_REFUSED")
        operation = self.operations[(organization_id, current.operation_id)]
        if operation.state != "RUNNING":
            raise StoreError("OPERATION_TERMINAL")
        failed_job = replace(
            current, state="DEAD_LETTERED", lease_owner=None, lease_token=None,
            claimed_at=None, lease_expires_at=None, failure_reason=reason_code,
        )
        failed_operation = replace(
            operation, state="FAILED", version=operation.version + 1, updated_at=now,
            failure_reason=reason_code, failure_retryable=retryable,
        )
        emitted = self._event(failed_operation, "RUNNING", reason_code)
        self._fail("failure.before_commit")
        self.jobs[(organization_id, job_id)] = failed_job
        self.operations[(organization_id, operation.id)] = failed_operation
        self.outbox.append(emitted)
        self.audit.append({"type": "harness.operation.state.changed.v1", "aggregateId": operation.id})
        return failed_operation

    def succeed(
        self,
        organization_id: str,
        job_id: str,
        worker_id: str,
        lease_token: str,
        now: int,
        outputs: Mapping[str, bytes],
    ) -> ProfileRevision:
        existing_job = self.jobs.get((organization_id, job_id))
        if existing_job is not None and existing_job.state == "SUCCEEDED" and existing_job.result_key:
            return self.profiles[existing_job.result_key]
        current = self._leased(organization_id, job_id, worker_id, lease_token, now)
        accepted, output_digests, profile_id = self._validate_outputs(outputs)
        binding = (
            organization_id, current.demand_id, current.demand_revision, current.demand_digest,
            current.compiler_wheel_digest, current.catalog_digest,
        )
        existing_key = self.profile_bindings.get(binding)
        if existing_key is not None:
            revision = self.profiles[existing_key]
        else:
            key = _digest(_canonical({"binding": binding, "profileDigest": output_digests["profile.json"]}))
            revision = ProfileRevision(
                key=key, organization_id=organization_id, profile_id=profile_id, revision=1,
                demand_id=current.demand_id, demand_revision=current.demand_revision,
                demand_digest=current.demand_digest, compiler_wheel_digest=current.compiler_wheel_digest,
                catalog_digest=current.catalog_digest, outputs=accepted,
                output_digests=output_digests, created_at=now,
            )
        operation = self.operations[(organization_id, current.operation_id)]
        if operation.state != "RUNNING":
            raise StoreError("OPERATION_TERMINAL")
        reference = {"kind": "harness-profile", "id": profile_id, "digest": output_digests["profile.json"]}
        completed = replace(
            operation, state="SUCCEEDED", version=operation.version + 1, updated_at=now,
            result_refs=(reference,), failure_reason=None, failure_retryable=None,
        )
        completed_job = replace(
            current, state="SUCCEEDED", lease_owner=None, lease_token=None, claimed_at=None,
            lease_expires_at=None, failure_reason=None, result_key=revision.key,
        )
        emitted = self._event(completed, "RUNNING", "COMPILATION_SUCCEEDED")
        self._fail("result.before_commit")
        self.profiles[revision.key] = revision
        self.profile_bindings[binding] = revision.key
        self.jobs[(organization_id, job_id)] = completed_job
        self.operations[(organization_id, operation.id)] = completed
        self.outbox.append(emitted)
        self.audit.append({"type": "profile.proposed.v1", "aggregateId": revision.profile_id})
        self.audit.append({"type": "harness.operation.state.changed.v1", "aggregateId": operation.id})
        return revision

    def _leased(self, organization_id: str, job_id: str, worker_id: str, lease_token: str, now: int) -> CompilationJob:
        current = self.jobs.get((organization_id, job_id))
        if current is None:
            raise StoreError("JOB_NOT_FOUND")
        if (
            current.state != "LEASED" or current.lease_owner != worker_id
            or current.lease_token != lease_token or current.lease_expires_at is None
            or current.lease_expires_at <= now
        ):
            raise StoreError("LEASE_FENCE_REFUSED")
        return current

    def _validate_outputs(self, outputs: Mapping[str, bytes]) -> tuple[Mapping[str, bytes], Mapping[str, str], str]:
        if tuple(outputs) != OUTPUT_NAMES or any(not isinstance(outputs[name], bytes) for name in OUTPUT_NAMES):
            raise StoreError("COMPILER_OUTPUT_SET_REFUSED")
        copied = {name: bytes(outputs[name]) for name in OUTPUT_NAMES}
        digests = {name: _digest(copied[name]) for name in OUTPUT_NAMES}
        if copied["profile.sha256"] != f"{digests['profile.json']}\n".encode("ascii"):
            raise StoreError("PROFILE_DIGEST_REFUSED")
        try:
            profile = json.loads(copied["profile.json"])
            profile_id = profile["profile"]["metadata"]["id"]
        except (KeyError, TypeError, UnicodeError, json.JSONDecodeError) as exc:
            raise StoreError("PROFILE_DOCUMENT_REFUSED") from exc
        if not isinstance(profile_id, str) or not re.fullmatch(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$", profile_id):
            raise StoreError("PROFILE_DOCUMENT_REFUSED")
        return copied, digests, profile_id

    def _event(self, operation: Operation, previous: str, reason_code: str) -> OutboxRecord:
        tenant = _tenant_id(operation.organization_id)
        resource_refs = list(operation.result_refs)
        event = {
            "specversion": "1.0",
            "id": _uuid4(),
            "source": "urn:planeon:harness:control.profile-compiler",
            "type": "harness.operation.state.changed.v1",
            "subject": operation.id,
            "time": _time(operation.updated_at),
            "datacontenttype": "application/json",
            "dataschema": "https://harness.planeon.ai/schemas/v1alpha1/events/harness-cloud-event.schema.json",
            "organizationid": tenant,
            "partitionkey": tenant,
            "sequence": operation.version,
            "data": {
                "schemaVersion": "harness.planeon.ai/event-data/v1alpha1",
                "aggregateKind": "Operation",
                "aggregateId": operation.id,
                "aggregateVersion": operation.version,
                "actor": {"type": "WORKLOAD", "id": "worker.profile-compiler"},
                "correlationId": operation.correlation_id,
                "causationId": None,
                "reasonCode": reason_code,
                "transition": {"from": previous, "to": operation.state},
                "resourceRefs": resource_refs,
                "evidenceRefs": [],
            },
        }
        return OutboxRecord(event=event, payload_digest=_digest(_canonical(event)))

    def deliver_next(self, sink: Callable[[Mapping[str, Any]], None], *, crash_after_delivery: bool = False) -> str | None:
        pending = [record for record in self.outbox if str(record.event["id"]) not in self.delivery_receipts]
        if not pending:
            return None
        record = min(pending, key=lambda item: (str(item.event["time"]), str(item.event["id"])))
        event_id = str(record.event["id"])
        sink(copy.deepcopy(record.event))
        if crash_after_delivery:
            raise StoreError("INJECTED_AFTER_DELIVERY")
        self._fail("delivery.before_receipt")
        self.delivery_receipts.add(event_id)
        self.audit.append({"type": "outbox.published.v1", "aggregateId": event_id})
        return event_id

    def accept_event(self, source_id: str, allowed_sources: set[str], event: Mapping[str, Any]) -> bool:
        if source_id not in allowed_sources:
            raise StoreError("EVENT_SOURCE_REFUSED")
        event_id = event.get("id")
        tenant = event.get("organizationid")
        if not isinstance(event_id, str) or not isinstance(tenant, str) or event.get("partitionkey") != tenant:
            raise StoreError("EVENT_PARTITION_REFUSED")
        identity = (tenant, event_id)
        digest = _digest(_canonical(event))
        existing = self.inbox.get(identity)
        if existing is not None:
            if _digest(_canonical(existing)) != digest:
                raise StoreError("EVENT_ID_CONFLICT")
            return False
        subject = event.get("subject")
        sequence = event.get("sequence")
        if not isinstance(subject, str) or not isinstance(sequence, int) or isinstance(sequence, bool):
            raise StoreError("EVENT_SEQUENCE_REFUSED")
        sequence_key = (tenant, subject)
        if sequence <= self.inbox_sequences.get(sequence_key, 0):
            raise StoreError("EVENT_SEQUENCE_REFUSED")
        self._fail("inbox.before_commit")
        self.inbox[identity] = copy.deepcopy(event)
        self.inbox_sequences[sequence_key] = sequence
        self.audit.append({"type": "event.accepted.v1", "aggregateId": event_id})
        return True


class CompilerWorker:
    """One-shot worker; scheduling and process lifecycle stay outside product code."""

    def __init__(self, store: CompilationStore, compiler: Compiler | None = None) -> None:
        self.store = store
        self.compiler = compiler or ExactCompiler()

    def run_once(self, organization_id: str, worker_id: str, now: int) -> str:
        job = self.store.claim(organization_id, worker_id, now)
        if job is None:
            return "IDLE_NO_JOB"
        assert job.lease_token is not None
        if job.compiler_wheel_digest != self.compiler.wheel_digest:
            self.store.fail(
                organization_id, job.id, worker_id, job.lease_token, now + 1,
                "COMPILER_WHEEL_MISMATCH", retryable=False,
            )
            return "DEAD_LETTERED"
        try:
            outputs = self.compiler.compile(job.compile_request, job.catalog_resources, job.catalog_digest)
        except CompilerInvocationError as exc:
            if exc.retryable:
                retried = self.store.retry(organization_id, job.id, worker_id, job.lease_token, now + 1, exc.reason_code)
                return retried.state
            self.store.fail(
                organization_id, job.id, worker_id, job.lease_token, now + 1,
                exc.reason_code, retryable=False,
            )
            return "DEAD_LETTERED"
        try:
            self.store.succeed(organization_id, job.id, worker_id, job.lease_token, now + 1, outputs)
            return "SUCCEEDED"
        except StoreError as exc:
            if exc.reason_code not in {
                "COMPILER_OUTPUT_SET_REFUSED",
                "PROFILE_DIGEST_REFUSED",
                "PROFILE_DOCUMENT_REFUSED",
            }:
                raise
            self.store.fail(
                organization_id, job.id, worker_id, job.lease_token, now + 1,
                exc.reason_code, retryable=False,
            )
            return "DEAD_LETTERED"
