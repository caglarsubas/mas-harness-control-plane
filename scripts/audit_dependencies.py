#!/usr/bin/env python3
"""Verify the closed CTRL-006 dependency-review snapshot without network access."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEMVER = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$")
INTEGRITY = re.compile(r"^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$")
REGISTRY = "https://registry.npmjs.org/"
BASE = "8e89226acfdcd1f5034d4ee71bb1a161553350b0"
EXPECTED_PREDECESSORS = {
    "schemaVersion": "planeon.control.ctrl-006-predecessor-lock/v1",
    "controlPlane": {"commit": BASE},
    "trust002": {
        "commit": "c9b4b66c9343e6824348be694df28f30e771f571",
        "exactMainRun": 33528837543,
        "guardrailRequestSha256": "f420c30c592f98b1b064e95265c1dd5743c09bf7b1a7db537fb1c83d48b296e8",
        "guardrailResponseSha256": "9c9e455ce5675c5e0ce0a0d02b227df21f67e7b73a7841b87200b872b4734709",
        "signedProfileSha256": "453d831272dc712e1c5294267df936ad1c5e8d65795e475c2fe0008234a613f6",
        "upstreamLockSha256": "422d2c93bdeaf858057a7962edd0ad61f16bfe5cd66cb4d3c25742d8958784c1",
    },
}


class ReviewError(ValueError):
    pass


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ReviewError(f"duplicate JSON member: {key}")
        result[key] = value
    return result


def load(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ReviewError(f"object required: {path.name}")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_predecessors() -> None:
    if load(ROOT / "docs/security/predecessor-locks.json") != EXPECTED_PREDECESSORS:
        raise ReviewError("CTRL-006 predecessor lock drift")
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", BASE, "HEAD"],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ReviewError("exact CTRL-005 base is not an ancestor of HEAD")


def inventory(packages: dict[str, object]) -> tuple[list[dict[str, object]], set[tuple[str, str]]]:
    items: list[dict[str, object]] = []
    scripts: set[tuple[str, str]] = set()
    for path, raw in sorted(packages.items()):
        if path == "":
            continue
        if not path.startswith("node_modules/") or not isinstance(raw, dict):
            raise ReviewError(f"closed installed package entry required: {path}")
        version = raw.get("version")
        license_id = raw.get("license")
        resolved = raw.get("resolved")
        integrity = raw.get("integrity")
        if not all(isinstance(item, str) and item for item in (version, license_id, resolved, integrity)):
            raise ReviewError(f"version, license, source, and integrity required: {path}")
        if not resolved.startswith(REGISTRY) or any(marker in resolved for marker in ("git+", "github.com", "#", "?")):
            raise ReviewError(f"non-registry or mutable source refused: {path}")
        if INTEGRITY.fullmatch(integrity) is None:
            raise ReviewError(f"integrity refused: {path}")
        has_script = raw.get("hasInstallScript", False)
        if not isinstance(has_script, bool):
            raise ReviewError(f"install-script marker refused: {path}")
        if has_script:
            scripts.add((path, version))
        items.append({
            "path": path,
            "version": version,
            "license": license_id,
            "resolved": resolved,
            "integrity": integrity,
            "hasInstallScript": has_script,
        })
    return items, scripts


def verify_installed(items: list[dict[str, object]], manifest: dict[str, object]) -> int:
    installed = 0
    available: set[str] = set()
    for item in items:
        metadata_path = ROOT / str(item["path"]) / "package.json"
        if not metadata_path.is_file() or metadata_path.is_symlink():
            continue
        metadata = load(metadata_path)
        if metadata.get("version") != item["version"] or metadata.get("license") != item["license"]:
            raise ReviewError(f"installed metadata drift: {item['path']}")
        installed += 1
        available.add(str(item["path"]))
    for group_name in ("dependencies", "devDependencies"):
        group = manifest[group_name]
        assert isinstance(group, dict)
        for name in group:
            if f"node_modules/{name}" not in available:
                raise ReviewError(f"direct package is not installed: {name}")
    return installed


def main() -> None:
    verify_predecessors()
    manifest = load(ROOT / "package.json")
    lock_path = ROOT / "package-lock.json"
    lock = load(lock_path)
    review = load(ROOT / "docs/security/dependency-review.json")
    if lock.get("lockfileVersion") != 3:
        raise ReviewError("package-lock v3 required")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        raise ReviewError("package-lock package inventory missing")
    root = packages[""]
    if root.get("dependencies") != manifest.get("dependencies") or root.get("devDependencies") != manifest.get("devDependencies"):
        raise ReviewError("manifest and lock roots differ")
    for group in (manifest.get("dependencies"), manifest.get("devDependencies")):
        if not isinstance(group, dict) or any(not isinstance(version, str) or SEMVER.fullmatch(version) is None for version in group.values()):
            raise ReviewError("direct dependencies must use exact semantic versions")

    required_review_keys = {
        "schemaVersion", "reviewedAt", "lockSha256", "packageCount", "packageInventorySha256",
        "allowedLicenses", "allowedInstallScripts", "advisorySources", "advisories", "runtimeAudit",
    }
    if set(review) != required_review_keys or review.get("schemaVersion") != "planeon.control.dependency-review/v1":
        raise ReviewError("dependency review shape refused")
    if review.get("lockSha256") != sha256(lock_path):
        raise ReviewError("dependency review does not bind the committed lock")
    items, scripts = inventory(packages)
    installed_count = verify_installed(items, manifest)
    inventory_digest = hashlib.sha256(json.dumps(items, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if review.get("packageCount") != len(items) or review.get("packageInventorySha256") != inventory_digest:
        raise ReviewError("reviewed package inventory drift")
    allowed_licenses = review.get("allowedLicenses")
    if not isinstance(allowed_licenses, list) or len(allowed_licenses) != len(set(allowed_licenses)):
        raise ReviewError("closed license allowlist required")
    unknown = sorted({str(item["license"]) for item in items} - set(allowed_licenses))
    if unknown:
        raise ReviewError(f"unknown license: {unknown[0]}")
    allowed_scripts = review.get("allowedInstallScripts")
    if not isinstance(allowed_scripts, list) or any(not isinstance(item, dict) or set(item) != {"path", "version", "execution"} or item.get("execution") != "SUPPRESSED_BY_NPM_CI_IGNORE_SCRIPTS" for item in allowed_scripts):
        raise ReviewError("install-script disposition refused")
    reviewed_scripts = {(str(item["path"]), str(item["version"])) for item in allowed_scripts}
    if scripts != reviewed_scripts:
        raise ReviewError("undeclared or stale install-script inventory")
    sources = review.get("advisorySources")
    if not isinstance(sources, list) or len(sources) < 2 or any(not isinstance(source, dict) or set(source) != {"name", "url", "checkedAt"} for source in sources):
        raise ReviewError("advisory source review missing")
    advisories = review.get("advisories")
    if not isinstance(advisories, list):
        raise ReviewError("advisory list missing")
    for item in advisories:
        if not isinstance(item, dict) or set(item) != {"id", "severity", "affected", "installedVersions", "disposition", "evidence"}:
            raise ReviewError("advisory disposition shape refused")
        if item.get("severity") in {"HIGH", "CRITICAL"} and item.get("disposition") not in {"REMEDIATED", "MITIGATED_NOT_RUNTIME_REACHABLE"}:
            raise ReviewError(f"unresolved release-blocking advisory: {item.get('id')}")
        if item.get("disposition") == "SUPPRESSED" or not isinstance(item.get("evidence"), str) or len(item["evidence"]) < 24:
            raise ReviewError("suppressed or unevidenced advisory refused")
    runtime = review.get("runtimeAudit")
    if runtime != {"command": "npm audit --omit=dev --omit=optional --json", "high": 0, "critical": 0}:
        raise ReviewError("production runtime audit disposition refused")
    print(f"dependency audit passed: exact predecessors, {len(items)} locked and {installed_count} platform-installed packages, {len(scripts)} suppressed install scripts, {len(advisories)} reviewed advisory")


if __name__ == "__main__":
    main()
