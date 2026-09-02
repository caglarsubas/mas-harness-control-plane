import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve("packages/db/migrations/demand/003_demand_approval.sql");
const sql = readFileSync(migrationPath, "utf8");

describe("CTRL-003 additive demand migration", () => {
  it("creates exactly the three packet-owned tenant tables", () => {
    const tables = [...sql.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1]);
    expect(tables).toEqual(["demand", "prerequisite_decision", "approval"]);
    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`organization_id = control.current_organization_id()`);
    }
  });

  it("enforces legal lifecycle, immutable decision prefixes, and no deletion", () => {
    expect(sql).toContain("CREATE FUNCTION control.guard_demand_transition()");
    expect(sql).toContain("CREATE FUNCTION control.guard_approval_transition()");
    expect(sql).toContain("APPROVAL_DECISION_PREFIX_MUTATED");
    expect(sql).toContain("APPROVAL_DECISION_APPEND_REQUIRED");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON control.prerequisite_decision");
    expect(sql).toContain("BEFORE DELETE ON control.demand");
    expect(sql).toContain("BEFORE DELETE ON control.approval");
    expect(sql).toContain("REVOKE DELETE, TRUNCATE ON control.demand, control.prerequisite_decision, control.approval FROM control_runtime");
  });

  it("is additive and leaves predecessor tables and questionnaire data untouched", () => {
    expect(sql).toMatch(/^BEGIN;/u);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/u);
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|SCHEMA|COLUMN)/iu);
    expect(sql).not.toMatch(/DELETE\s+FROM/iu);
    expect(sql).not.toMatch(/ALTER TABLE control\.(?:tenant|questionnaire_session|answer_revision|readiness_finding|audit_event|idempotency_record)\b/iu);
    expect(sql).not.toMatch(/CREATE EXTENSION|dblink|http:|https:/iu);
  });
});
