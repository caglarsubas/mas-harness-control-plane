"""Clean-room deterministic CTRL-004 contract fixtures."""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping

TEST_DIRECTORY = Path(__file__).resolve().parent
WORKER_DIRECTORY = TEST_DIRECTORY.parents[1] / "workers" / "profile-compiler"
if str(WORKER_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(WORKER_DIRECTORY))

from planeon_harness_contracts.models import MANDATORY_READINESS_GATES
from planeon_harness_contracts.validation import EXPECTED_HARNESSES, EXPECTED_PROVIDERS

from profile_compiler.domain import CompilationJob, CompilationStore, Operation

ORGANIZATION_A = "11111111-1111-4111-8111-111111111111"
ORGANIZATION_B = "22222222-2222-4222-8222-222222222222"
WORKER_A = "worker.compiler-a"
WORKER_B = "worker.compiler-b"
NOW = 1_780_272_000
CATALOG_DIGEST = f"sha256:{'c' * 64}"
DEMAND_DIGEST = f"sha256:{'d' * 64}"
INPUT_DIGEST = f"sha256:{'e' * 64}"
IDEMPOTENCY_DIGEST = f"sha256:{'f' * 64}"


def digest(value: bytes | str) -> str:
    raw = value.encode("utf-8") if isinstance(value, str) else value
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _compatibility() -> Mapping[str, list[str]]:
    return {
        "deploymentModes": ["operator-hosted-saas", "tenant-public-cloud", "self-managed", "air-gapped"],
        "architectures": ["amd64", "arm64", "platform-supplied"],
        "operatingSystems": ["linux", "macos", "platform-supplied"],
        "kubernetesDistributions": ["upstream", "k3s", "openshift", "none", "platform-supplied"],
    }


def _install_unit(resource_id: str) -> Mapping[str, Any]:
    suffix = resource_id.replace(".", "-")
    return {
        "id": f"unit.{suffix}",
        "type": "OCI_IMAGE",
        "artifactName": f"planeon/{suffix}",
        "independent": True,
        "digestRequiredAtRelease": True,
        "runtimeDownloadAllowed": False,
    }


def _provider_binding(provider_id: str) -> tuple[str, str]:
    if provider_id.startswith("provider.runtime.infrastructure."):
        return "group.infrastructure-provider", "runtime.infrastructure"
    if provider_id.startswith("provider.planeon."):
        return "group.model-backend", "runtime.model-inference"
    if provider_id.startswith("provider.execution.protocol-"):
        return "group.protocol-adapter", "execution.protocol-interoperability"
    if provider_id.startswith("provider.execution.sandbox-"):
        return "group.native-sandbox-provider", "execution.tool-skill-sandbox"
    if provider_id.startswith("provider.execution.decision-"):
        return "group.decision-provider", "execution.ml-decision"
    raise AssertionError(f"unmapped canonical provider: {provider_id}")


def catalog_resources() -> tuple[Mapping[str, Any], ...]:
    resources: list[Mapping[str, Any]] = []
    for harness_id, plane in sorted(EXPECTED_HARNESSES.items()):
        capability_id = "runtime.infrastructure.requested" if harness_id == "runtime.infrastructure" else f"capability.{harness_id}"
        capabilities: list[Mapping[str, Any]] = [
            {"id": capability_id, "classification": "PUBLIC_DEMAND", "signedAttestationRequired": False}
        ]
        if harness_id == "runtime.infrastructure":
            capabilities.extend(
                [
                    {"id": "provider.activation", "classification": "PUBLIC_DEMAND", "signedAttestationRequired": False},
                    {"id": "architecture.arm64-available", "classification": "ENVIRONMENT_FACT", "signedAttestationRequired": True},
                    {"id": "connectivity.connected", "classification": "ENVIRONMENT_FACT", "signedAttestationRequired": True},
                ]
            )
        module_id = f"module.{harness_id}.core"
        resources.append(
            {
                "apiVersion": "harness.planeon.ai/v1alpha1",
                "kind": "HarnessClassDefinition",
                "metadata": {"id": harness_id, "version": "0.1.0"},
                "spec": {
                    "plane": plane,
                    "moduleIds": [module_id],
                    "capabilities": capabilities,
                    "dependencies": [],
                    "conflicts": [],
                    "evidenceRequirements": ["SOURCE"],
                },
            }
        )
        resources.append(
            {
                "apiVersion": "harness.planeon.ai/v1alpha1",
                "kind": "HarnessModuleDefinition",
                "metadata": {"id": module_id, "version": "0.1.0"},
                "spec": {
                    "harnessId": harness_id,
                    "providesCapabilities": [capability_id],
                    "requiresModules": [],
                    "installUnits": [_install_unit(module_id)],
                    "externalEgressAllowed": False,
                    "runtimeDownloadsAllowed": False,
                    "license": {"sourceAvailable": True, "releaseAdmission": "ALLOWED"},
                    "lifecycle": {
                        "healthCheckRequired": True,
                        "rollbackRequired": True,
                        "uninstallSupported": True,
                    },
                    "compatibility": _compatibility(),
                },
            }
        )
    for provider_id in sorted(EXPECTED_PROVIDERS):
        group_id, harness_id = _provider_binding(provider_id)
        resources.append(
            {
                "apiVersion": "harness.planeon.ai/v1alpha1",
                "kind": "FrameworkProviderDefinition",
                "metadata": {"id": provider_id, "version": "0.1.0"},
                "spec": {
                    "harnessId": harness_id,
                    "selectorGroup": group_id,
                    "selectorCapability": provider_id,
                    "activatedByCapabilities": ["provider.activation"],
                    "providerCredentialsRequired": False,
                    "externalTelemetry": False,
                    "runtimeDownloadsAllowed": False,
                    "releaseStatus": "PLANNED",
                    "installUnits": [_install_unit(provider_id)],
                    "compatibility": _compatibility(),
                    "license": {"releaseAdmission": "BLOCKED_PENDING_UPSTREAM_LICENSE_EVIDENCE"},
                },
            }
        )
    return tuple(resources)


def compile_request(profile_id: str = "profile.fixture") -> Mapping[str, Any]:
    session_id = "questionnaire-session.fixture"
    return {
        "schemaVersion": "harness.planeon.ai/compile-request/v1alpha1",
        "metadata": {
            "tenantId": "tenant.fixture",
            "demandId": "demand.fixture",
            "profileId": profile_id,
            "version": "0.1.0",
        },
        "questionnaireAnswerSet": {
            "apiVersion": "harness.planeon.ai/v1alpha1",
            "kind": "QuestionnaireAnswerSet",
            "metadata": {"id": "answer-set.fixture", "version": "0.1.0"},
            "spec": {
                "questionnaireDefinitionId": "questionnaire.fixture",
                "questionnaireSessionId": session_id,
                "status": "SUBMITTED",
                "answers": [],
            },
        },
        "readinessAssessment": {
            "apiVersion": "harness.planeon.ai/v1alpha1",
            "kind": "DataReadinessAssessment",
            "metadata": {"id": "readiness.fixture", "version": "0.1.0"},
            "spec": {
                "questionnaireSessionId": session_id,
                "overallStatus": "READY",
                "gateResults": [
                    {
                        "gateId": gate_id,
                        "status": "PASS",
                        "evidenceIds": ["evidence.fixture"],
                        "reasonCode": "gate.pass",
                    }
                    for gate_id in MANDATORY_READINESS_GATES
                ],
                "missingGateIds": [],
            },
        },
        "demand": {
            "requestedCapabilities": ["runtime.infrastructure.requested"],
            "acceptedPrerequisiteHarnessIds": [],
            "environment": {
                "tenantId": "tenant.fixture",
                "deploymentMode": "self-managed",
                "architecture": "arm64",
                "operatingSystem": "macos",
                "kubernetesDistribution": "none",
                "capabilities": ["architecture.arm64-available", "connectivity.connected"],
                "attestationDigest": f"sha256:{'a' * 64}",
                "signatureStatus": "VERIFIED",
            },
            "assuranceSubjects": {"harnessIds": [], "capabilityIds": []},
            "executionBudget": {
                "maxConcurrentTasks": 1,
                "maxTaskSeconds": 60,
                "maxRetries": 2,
                "maxToolCalls": 0,
                "maxModelTokens": 0,
            },
        },
    }


def create_job(store: CompilationStore, *, organization_id: str = ORGANIZATION_A, now: int = NOW) -> tuple[Operation, CompilationJob]:
    request = compile_request()
    resources = catalog_resources()
    return store.create_job(
        organization_id=organization_id,
        demand_id="demand.fixture",
        demand_revision=7,
        demand_digest=DEMAND_DIGEST,
        input_digest=INPUT_DIGEST,
        catalog_digest=CATALOG_DIGEST,
        compiler_wheel_digest=f"sha256:{'5' * 64}",
        compile_request=copy.deepcopy(request),
        catalog_resources=copy.deepcopy(resources),
        actor_id="actor.fixture",
        idempotency_key_digest=IDEMPOTENCY_DIGEST,
        now=now,
    )


class FakeCompiler:
    def __init__(
        self,
        outputs: Mapping[str, bytes],
        *,
        reason_code: str | None = None,
        retryable: bool = False,
        wheel_digest: str = f"sha256:{'5' * 64}",
    ) -> None:
        self._outputs = outputs
        self._reason_code = reason_code
        self._retryable = retryable
        self._wheel_digest = wheel_digest
        self.calls = 0

    @property
    def wheel_digest(self) -> str:
        return self._wheel_digest

    def compile(self, _request: Mapping[str, Any], _resources: tuple[Mapping[str, Any], ...], _catalog_digest: str) -> Mapping[str, bytes]:
        from profile_compiler.compiler_adapter import CompilerInvocationError

        self.calls += 1
        if self._reason_code is not None:
            raise CompilerInvocationError(self._reason_code, retryable=self._retryable)
        return self._outputs


def deterministic_outputs(profile_id: str = "profile.fixture") -> Mapping[str, bytes]:
    profile_bytes = (json.dumps({"profile": {"metadata": {"id": profile_id}}}, sort_keys=True, separators=(",", ":")) + "\n").encode()
    outputs: dict[str, bytes] = {
        "profile.json": profile_bytes,
        "bom.json": b"{}\n",
        "install-plan.json": b"{}\n",
        "evidence-plan.json": b"{}\n",
        "explanation.md": b"# Fixture\n",
        "profile.sha256": f"{digest(profile_bytes)}\n".encode("ascii"),
    }
    return outputs
