"""Exact dependency admission and deterministic compiler invocation."""

from __future__ import annotations

import hashlib
import json
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any, Mapping, Sequence

from planeon_harness_contracts import canonical as canonical_module
from planeon_harness_contracts import compiler as compiler_module
from planeon_harness_contracts.compiler import OUTPUT_NAMES, compile_profile, write_compilation_outputs
from planeon_harness_contracts.errors import CompilationError

LOCK_PATH = Path(__file__).resolve().parents[1] / "dependencies.lock.json"
LOCK_SCHEMA = "planeon.control.compiler-dependencies/v1alpha1"


class DependencyLockError(RuntimeError):
    """The installed compiler environment does not match source authority."""


class CompilerInvocationError(RuntimeError):
    """A stable compiler failure without request or exception payload."""

    def __init__(self, reason_code: str, *, retryable: bool = False) -> None:
        super().__init__(reason_code)
        self.reason_code = reason_code
        self.retryable = retryable


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _closed(value: object, fields: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise DependencyLockError(f"{label.upper()}_LOCK_REFUSED")
    return value


def validate_dependency_lock(path: Path = LOCK_PATH) -> Mapping[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise DependencyLockError("DEPENDENCY_LOCK_REFUSED")
    try:
        lock = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DependencyLockError("DEPENDENCY_LOCK_REFUSED") from exc
    root = _closed(
        lock,
        {
            "schemaVersion", "python", "contracts", "production", "systemBoundary",
            "acceptanceAdapter", "network", "runtimeDownloads",
        },
        "dependency",
    )
    if root["schemaVersion"] != LOCK_SCHEMA or root["network"] != "DENY_ALL_OUTBOUND" or root["runtimeDownloads"] is not False:
        raise DependencyLockError("DEPENDENCY_POLICY_REFUSED")
    python = _closed(root["python"], {"version", "uvVersion"}, "python")
    if python != {"version": "3.12.14", "uvVersion": "0.12.7"} or sys.version_info[:3] != (3, 12, 14):
        raise DependencyLockError("PYTHON_LOCK_REFUSED")
    contracts = _closed(
        root["contracts"],
        {
            "repository", "commit", "releaseManifestSha256", "wheel", "wheelSha256",
            "compilerSourceSha256", "canonicalSourceSha256",
        },
        "contracts",
    )
    if contracts != {
        "repository": "caglarsubas/mas-harness-contracts",
        "commit": "2146278a95344cd2a8e22596b2f315b46edffc88",
        "releaseManifestSha256": "c5dd4c39d1c69d07f8d8de3d1a09584bb906172fee2d5ac20ad25ff344b0db79",
        "wheel": "planeon_harness_contracts-0.1.0-py3-none-any.whl",
        "wheelSha256": "53500a690c8b7614e0cb6ea1e4d78e0831b94a458523e558fedfeb13428bb97b",
        "compilerSourceSha256": "0b0960c87bc1214e795144968db3976bd548c80e6002b03bc3f6e292303a764b",
        "canonicalSourceSha256": "ef551e4c996762770c2547302f4cd4dc61b6695b3f6619de0428e8527612dbdc",
    }:
        raise DependencyLockError("CONTRACT_LOCK_REFUSED")
    compiler_path = Path(compiler_module.__file__).resolve(strict=True)
    canonical_path = Path(canonical_module.__file__).resolve(strict=True)
    if _sha256(compiler_path) != contracts["compilerSourceSha256"] or _sha256(canonical_path) != contracts["canonicalSourceSha256"]:
        raise DependencyLockError("CONTRACT_SOURCE_REFUSED")
    if version("planeon-harness-contracts") != "0.1.0":
        raise DependencyLockError("CONTRACT_VERSION_REFUSED")
    production = root["production"]
    if not isinstance(production, list) or len(production) != 2:
        raise DependencyLockError("PRODUCTION_CLOSURE_REFUSED")
    expected_production = (
        {
            "name": "psycopg",
            "version": "3.3.4",
            "filename": "psycopg-3.3.4-py3-none-any.whl",
            "sha256": "b6bbc25ccf05c8fad3b061d9db2ef0909a555171b84b07f29458a447253d679a",
            "license": "LGPL-3.0-only",
        },
        {
            "name": "typing-extensions",
            "version": "4.16.0",
            "filename": "typing_extensions-4.16.0-py3-none-any.whl",
            "sha256": "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8",
            "license": "PSF-2.0",
        },
    )
    production_fields = {"name", "version", "filename", "sha256", "license"}
    if tuple(production) != expected_production or any(
        not isinstance(item, dict) or set(item) != production_fields for item in production
    ):
        raise DependencyLockError("PRODUCTION_CLOSURE_REFUSED")
    for package, expected in {"psycopg": "3.3.4", "typing-extensions": "4.16.0"}.items():
        if version(package) != expected:
            raise DependencyLockError("PRODUCTION_CLOSURE_REFUSED")
    adapter = _closed(
        root["acceptanceAdapter"],
        {"platform", "name", "version", "filename", "sha256", "license", "distribution"},
        "acceptance-adapter",
    )
    if sys.platform == "darwin":
        from psycopg import pq

        if adapter != {
            "platform": "macos-arm64-cpython312",
            "name": "psycopg-binary",
            "version": "3.3.4",
            "filename": "psycopg_binary-3.3.4-cp312-cp312-macosx_11_0_arm64.whl",
            "sha256": "6402a9d8146cf4b3974ded3fd28a971e83dc6a0333eb7822524a3aa20b546578",
            "license": "LGPL-3.0-only",
            "distribution": "RUNNER_ONLY_NOT_PRODUCTION_SELECTION",
        } or version("psycopg-binary") != "3.3.4" or pq.__impl__ != "binary":
            raise DependencyLockError("ACCEPTANCE_ADAPTER_REFUSED")
    boundary = _closed(root["systemBoundary"], {"name", "custody", "required"}, "system-boundary")
    if boundary != {"name": "libpq", "custody": "OPERATOR_SUPPLIED_IMAGE_INVENTORY", "required": True}:
        raise DependencyLockError("SYSTEM_BOUNDARY_REFUSED")
    return root


class ExactCompiler:
    """Invoke only the released pure compiler after local dependency admission."""

    def __init__(self, lock_path: Path = LOCK_PATH) -> None:
        self._lock = validate_dependency_lock(lock_path)

    @property
    def wheel_digest(self) -> str:
        return f"sha256:{self._lock['contracts']['wheelSha256']}"

    def compile(
        self,
        request: Mapping[str, Any],
        resources: Sequence[Mapping[str, Any]],
        catalog_digest: str,
    ) -> Mapping[str, bytes]:
        try:
            outputs = compile_profile(request, resources, catalog_digest)
        except CompilationError as exc:
            raise CompilerInvocationError(exc.code, retryable=False) from exc
        if tuple(outputs) != OUTPUT_NAMES or any(not isinstance(outputs[name], bytes) for name in OUTPUT_NAMES):
            raise CompilerInvocationError("COMPILER_OUTPUT_SET_REFUSED", retryable=False)
        return outputs

    @staticmethod
    def write(directory: Path, outputs: Mapping[str, bytes]) -> None:
        """Delegate closed output-path checks to the exact released compiler."""

        write_compilation_outputs(directory, outputs)
