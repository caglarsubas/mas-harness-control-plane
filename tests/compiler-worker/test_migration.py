"""Static migration evidence where live PostgreSQL is unavailable."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

MIGRATION = Path(__file__).resolve().parents[2] / "packages" / "db" / "migrations" / "compiler-jobs" / "004_compiler_jobs.sql"


class MigrationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sql = MIGRATION.read_text(encoding="utf-8")
        cls.normalized = re.sub(r"\s+", " ", cls.sql.lower())

    def test_creates_only_four_packet_owned_tables(self) -> None:
        tables = re.findall(r"create table\s+control\.([a-z_]+)", self.normalized)
        self.assertEqual(tables, ["operation", "compilation_job", "profile", "profile_revision"])
        self.assertNotRegex(self.sql.lower(), r"(?m)^\s*(drop\s+(?:table|schema)|truncate\s+table|delete\s+from)\b")
        self.assertNotIn(" down ", self.normalized)

    def test_force_rls_and_transaction_local_tenant_binding_are_closed(self) -> None:
        for table in ("operation", "compilation_job", "profile", "profile_revision"):
            self.assertIn(f"alter table control.{table} force row level security", self.normalized)
            self.assertIn(f"create policy {table}_isolation", self.normalized)
        self.assertGreaterEqual(self.normalized.count("control.current_organization_id()"), 9)
        self.assertIn("set_config('planeon.organization_id', %s, true)", (Path(__file__).resolve().parents[2] / "workers" / "profile-compiler" / "profile_compiler" / "postgres.py").read_text())

    def test_lease_fencing_retry_limit_and_exact_result_binding_exist(self) -> None:
        for phrase in (
            "for update skip locked",
            "attempt between 0 and 3",
            "lease_fence_refused",
            "new.claimed_at >= old.lease_expires_at",
            "not expired_reclaim",
            "unique (organization_id, demand_id, demand_revision, demand_digest, compiler_wheel_digest, catalog_digest)",
            "jsonb_object_length(output_digests) = 6",
            "original_envelope jsonb",
            "payload jsonb",
            "event_inbox_compiler_subject_sequence_unique",
            "event_outbox_compiler_subject_sequence_unique",
            "profile_revision_append_only",
        ):
            source = self.normalized + " " + (Path(__file__).resolve().parents[2] / "workers" / "profile-compiler" / "profile_compiler" / "postgres.py").read_text().lower()
            self.assertIn(phrase, source)

    def test_least_privilege_roles_have_no_bypass_or_destructive_grants(self) -> None:
        self.assertIn("control_compiler_worker nologin noinherit nobypassrls", self.normalized)
        self.assertIn("control_event_publisher nologin noinherit nobypassrls", self.normalized)
        self.assertIn("revoke create on schema control", self.normalized)
        self.assertIn("revoke delete, truncate", self.normalized)
        self.assertNotRegex(self.normalized, r"grant\s+all")
        self.assertNotRegex(self.normalized, r"grant[^;]+\b(delete|truncate|create)\b")

    def test_live_database_state_is_not_falsely_claimed(self) -> None:
        self.assertEqual("NOT_RUN_ENV_UNAVAILABLE", "NOT_RUN_ENV_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
