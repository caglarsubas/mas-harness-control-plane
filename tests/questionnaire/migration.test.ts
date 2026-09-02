import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { unavailablePostgreSqlRuntimeEvidence } from "../../packages/db/runtime-evidence";

const ROOT = resolve(import.meta.dirname, "../..");
const migration = readFileSync(resolve(ROOT, "packages/db/migrations/questionnaire/002_questionnaire.sql"), "utf8");

describe("additive questionnaire persistence source", () => {
  it("creates only the three packet-owned tables and has no destructive down path", () => {
    const tables = [...migration.matchAll(/CREATE TABLE\s+control\.([a-z_]+)/gu)].map((match) => match[1]);
    expect(tables).toEqual(["questionnaire_session", "answer_revision", "readiness_finding"]);
    expect(migration).not.toMatch(/^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|ALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b)/imu);
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
  });

  it("forces tenant RLS and append-only revision/finding history", () => {
    for (const table of ["questionnaire_session", "answer_revision", "readiness_finding"]) {
      expect(migration).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain("organization_id = control.current_organization_id()");
    }
    expect(migration).toContain("answer_revision_append_only");
    expect(migration).toContain("readiness_finding_append_only");
    expect(migration).toContain("control.reject_append_only_mutation()");
    expect(migration).toContain("REVOKE DELETE, TRUNCATE");
  });

  it("grants only bounded session updates and reports live PostgreSQL honestly unavailable", () => {
    expect(migration).toMatch(/GRANT UPDATE \(state, current_stage_id, completed_stage_ids, current_revision, updated_at, version, audit_event_id\)/u);
    expect(migration).not.toMatch(/GRANT\s+(?:ALL|UPDATE)\s+ON\s+control\.questionnaire_session/iu);
    expect(unavailablePostgreSqlRuntimeEvidence()).toEqual({
      axis: "RUNTIME",
      state: "NOT_RUN_ENV_UNAVAILABLE",
      reasonCode: "DISPOSABLE_LOCAL_POSTGRESQL_NOT_SUPPLIED",
    });
  });
});
