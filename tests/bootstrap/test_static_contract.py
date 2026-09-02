from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from ci.handlers.prefetch import BASE, dependency_errors, history_errors

ROOT = Path(__file__).resolve().parents[2]


class StaticContractTests(unittest.TestCase):
    def test_container_sources_are_non_root_and_fetch_free(self) -> None:
        for relative in ("apps/control-web/Containerfile", "workers/profile-compiler/Containerfile"):
            text = (ROOT / relative).read_text(encoding="utf-8")
            self.assertRegex(text, r"(?m)^ARG BASE_IMAGE$")
            self.assertIn("FROM ${BASE_IMAGE}", text)
            self.assertIn("USER 65532:65532", text)
            self.assertIn("ENTRYPOINT [", text)
            self.assertNotRegex(text, r"(?m)^(RUN|ADD)\s")

    def test_chart_is_inert_digest_only_and_provisions_no_external_service(self) -> None:
        chart = ROOT / "deploy/helm/control-plane"
        values = (chart / "values.yaml").read_text(encoding="utf-8")
        templates = "\n".join(path.read_text(encoding="utf-8") for path in sorted((chart / "templates").glob("*")) if path.is_file())
        self.assertEqual(values.count("enabled: false"), 2)
        self.assertIn("sha256:[0-9a-f]{64}", templates)
        for required in ("runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false", 'drop: ["ALL"]', "type: RuntimeDefault", "ingress: []", "egress: []"):
            self.assertIn(required, templates)
        for forbidden in ("kind: Secret", "kind: Ingress", "kind: Route", "kind: PersistentVolumeClaim", "LoadBalancer", "cert-manager"):
            self.assertNotIn(forbidden, templates)

    def test_prisma_and_sql_own_the_same_foundation_tables(self) -> None:
        sql = (ROOT / "packages/db/migrations/001_foundation.sql").read_text(encoding="utf-8")
        prisma = (ROOT / "prisma/schema.prisma").read_text(encoding="utf-8")
        tables = re.findall(r"CREATE TABLE control\.([a-z_]+)", sql)
        mapped = re.findall(r'@@map\("([a-z_]+)"\)', prisma)
        self.assertEqual(tables, mapped)

    def test_predecessor_lock_is_closed_and_source_contains_no_private_key(self) -> None:
        lock = json.loads((ROOT / "apps/control-web/contracts.lock.json").read_text(encoding="utf-8"))
        self.assertEqual(set(lock), {"schemaVersion", "sdk002", "ind001", "met003"})
        private_key_marker = "BEGIN " + "PRIVATE KEY"
        for base in (ROOT / "apps", ROOT / "workers", ROOT / "packages", ROOT / "tests"):
            for path in base.rglob("*"):
                if path.is_file() and "__pycache__" not in path.parts and path.suffix in {".ts", ".tsx", ".py", ".json", ".sql"}:
                    self.assertNotIn(private_key_marker, path.read_text(encoding="utf-8"), path.as_posix())

    def test_porting_ledger_is_the_exact_no_authorization_sentinel(self) -> None:
        self.assertEqual(
            (ROOT / "PORTING.yaml").read_text(encoding="utf-8"),
            "schemaVersion: harness.planeon.ai/porting-ledger/v1alpha1\n"
            "repository: mas-harness-control-plane\n"
            "status: NO_AUTHORIZATION\n"
            "authorizationId: null\n"
            "mappings: []\n"
            "copiedFiles: []\n"
            "appliedPorts: []\n",
        )

    def test_strict_typecheck_precedes_the_build_when_next_skips_its_duplicate_pass(self) -> None:
        handler = (ROOT / "ci/handlers/bootstrap_e2e.py").read_text(encoding="utf-8")
        config = (ROOT / "apps/control-web/next.config.ts").read_text(encoding="utf-8")
        self.assertLess(handler.index('run("npm", "run", "typecheck")'), handler.index('run("npm", "run", "build")'))
        self.assertIn("ignoreBuildErrors: true", config)

    def test_prefetch_uses_exact_root_ancestry_without_one_commit_limit(self) -> None:
        handler = (ROOT / "ci/handlers/prefetch.py").read_text(encoding="utf-8")
        self.assertNotIn('"HEAD^1"', handler)
        for required in (
            '"--is-shallow-repository"',
            '"rev-list", "--max-parents=0", "HEAD"',
            '"merge-base", "--is-ancestor", BASE, "HEAD"',
            '"refs/replace"',
            '"info/grafts"',
        ):
            self.assertIn(required, handler)
        self.assertEqual(
            history_errors(
                head="descendant",
                shallow="false",
                roots=[BASE],
                base_exists=True,
                base_is_ancestor=True,
                replace_refs=[],
                graft_path_exists=False,
            ),
            [],
        )
        negative_facts = {
            "shallow": {"shallow": "true"},
            "root": {"roots": ["0" * 40]},
            "missing": {"base_exists": False},
            "ancestor": {"base_is_ancestor": False},
            "replace": {"replace_refs": ["refs/replace/unsafe"]},
            "graft": {"graft_path_exists": True},
        }
        baseline = {
            "head": "descendant",
            "shallow": "false",
            "roots": [BASE],
            "base_exists": True,
            "base_is_ancestor": True,
            "replace_refs": [],
            "graft_path_exists": False,
        }
        for name, changed in negative_facts.items():
            with self.subTest(name=name):
                self.assertTrue(history_errors(**{**baseline, **changed}))

    def test_prefetch_preserves_bootstrap_pins_and_allows_exact_additions(self) -> None:
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
        manifest["dependencies"]["yaml"] = "2.9.0"
        lock["packages"][""]["dependencies"]["yaml"] = "2.9.0"
        self.assertEqual(dependency_errors(manifest, lock), [])

        manifest["dependencies"]["react"] = "^19.2.0"
        lock["packages"][""]["dependencies"]["react"] = "^19.2.0"
        self.assertTrue(dependency_errors(manifest, lock))


if __name__ == "__main__":
    unittest.main()
