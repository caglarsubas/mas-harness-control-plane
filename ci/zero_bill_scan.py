#!/usr/bin/env python3
"""Closed CTRL-001 zero-bill and deployment-source admission."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

FORBIDDEN_WORKFLOW = (
    "ubuntu-latest", "macos-latest", "windows-latest", "upload-artifact",
    "download-artifact", "actions/cache", "docker://", "schedule:", "push:",
    "packages: write",
)
FORBIDDEN_KINDS = (
    "kind: Secret", "kind: Namespace", "kind: PersistentVolume",
    "kind: PersistentVolumeClaim", "kind: Route", "kind: Ingress",
)
FORBIDDEN_RUNTIME = (
    "fetch(", "axios", "@vercel/analytics", "@vercel/speed-insights",
    "next/font/google", "remotePatterns: [{", "api_key", "apikey",
    "process.env.tenant", "process.env.organization",
)


def refuse(message: str) -> None:
    raise SystemExit(f"zero-bill scan refused: {message}")


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) == 2 else ".").resolve()
    if not root.is_dir() or root.is_symlink():
        refuse("scan root must be a regular directory")
    for base in (root / "apps", root / "workers", root / "packages", root / "prisma", root / "deploy", root / "ci"):
        for current, directories, files in os.walk(base, followlinks=False):
            directories[:] = [name for name in directories if name not in {".next", "node_modules", "__pycache__"}]
            for name in directories + files:
                if (Path(current) / name).is_symlink():
                    refuse(f"linked first-party source is forbidden: {(Path(current) / name).relative_to(root)}")

    workflow = (root / ".github/workflows/verify.yml").read_text(encoding="utf-8")
    if any(token in workflow for token in FORBIDDEN_WORKFLOW):
        refuse("workflow contains a hosted, retained, scheduled, package, or container feature")
    required_workflow = (
        "pull_request:", "workflow_dispatch:", "permissions:\n  contents: read",
        "runs-on: [self-hosted, harness-engineering, ephemeral, credential-free]",
        "timeout-minutes: 15", "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
        "persist-credentials: false", "fetch-depth: 0",
        "run: /opt/planeon/bin/harness-offline-launch",
    )
    if any(token not in workflow for token in required_workflow) or workflow.count("uses:") != 1 or workflow.count("run:") != 1:
        refuse("workflow is outside the pinned two-step credential-free contract")

    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    forbidden_packages = ("@vercel/", "stripe", "auth0", "firebase", "openai", "anthropic", "sentry")
    if any(name.startswith(forbidden_packages) for name in package["dependencies"] | package["devDependencies"]):
        refuse("package manifest contains a hosted or provider-specific dependency")
    if set(package.get("scripts", {})) & {"preinstall", "install", "postinstall", "prepare", "publish"}:
        refuse("package manifest contains an install or publication lifecycle script")

    runtime_files = list((root / "apps/control-web/src").rglob("*.ts")) + list((root / "apps/control-web/src").rglob("*.tsx"))
    for path in runtime_files:
        text = path.read_text(encoding="utf-8").casefold()
        if any(token.casefold() in text for token in FORBIDDEN_RUNTIME):
            refuse(f"runtime source contains a network, provider, key, or caller-tenant default: {path.relative_to(root)}")

    for relative in ("apps/control-web/Containerfile", "workers/profile-compiler/Containerfile"):
        text = (root / relative).read_text(encoding="utf-8")
        if not re.search(r"(?m)^ARG BASE_IMAGE$", text) or "FROM ${BASE_IMAGE}" not in text:
            refuse(f"{relative} does not require an external immutable base")
        if re.search(r"(?m)^(RUN|ADD)\s", text) or "USER 65532:65532" not in text or "ENTRYPOINT [" not in text:
            refuse(f"{relative} can fetch, mutate, or run as root")

    chart = root / "deploy/helm/control-plane"
    values = (chart / "values.yaml").read_text(encoding="utf-8")
    templates = "\n".join(path.read_text(encoding="utf-8") for path in sorted((chart / "templates").glob("*")) if path.is_file())
    if values.count("enabled: false") != 2 or 'repository: ""' not in values or 'digest: ""' not in values or "enabled: true" in values:
        refuse("chart defaults are not inert")
    required_chart = (
        "sha256:[0-9a-f]{64}", "runAsNonRoot: true", "readOnlyRootFilesystem: true",
        "allowPrivilegeEscalation: false", 'drop: ["ALL"]', "type: RuntimeDefault",
        "automountServiceAccountToken: false", "resources:", "ingress: []", "egress: []",
    )
    if any(token not in templates for token in required_chart) or any(token in templates for token in FORBIDDEN_KINDS):
        refuse("chart security, digest, or provisioning contract drifted")
    if any(token in templates for token in ("LoadBalancer", "cert-manager", "external-dns", "helm.sh/hook")):
        refuse("chart contains public or implicit infrastructure behavior")

    porting = (root / "PORTING.yaml").read_text(encoding="utf-8")
    expected_porting = """schemaVersion: harness.planeon.ai/porting-ledger/v1alpha1
repository: mas-harness-control-plane
status: NO_AUTHORIZATION
authorizationId: null
mappings: []
copiedFiles: []
appliedPorts: []
"""
    if porting != expected_porting:
        refuse("PORTING bootstrap sentinel drifted")
    print("zero-bill scan passed: no hosted runner, retained Actions feature, paid/API-key dependency, remote telemetry, cloud provisioning, runtime download, mutable image, public route, or authorized port")


if __name__ == "__main__":
    main()
