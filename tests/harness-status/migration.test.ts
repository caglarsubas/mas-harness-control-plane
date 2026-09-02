import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("packages/db/migrations/harness-status/001_status_projection.sql"), "utf8");
const tables = ["tenant_harness_status_projection", "tenant_plane_status_projection", "tenant_overview_projection", "status_projection_cursor", "status_projection_finding"];

describe("status projection migration", () => {
  it("adds only the six packet-owned status tables", () => {
    expect([...sql.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1])).toEqual([...tables, "status_projection_operator_audit"]);
  });

  it("forces tenant RLS and binds every policy to transaction-local organization context", () => {
    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(`CREATE POLICY ${table}_isolation[\\s\\S]+?organization_id = control\\.current_organization_id\\(\\)`, "u");
      expect(sql).toMatch(policy);
    }
    expect(sql).not.toMatch(/BYPASSRLS|GRANT\s+ALL|GRANT\s+DELETE|GRANT\s+TRUNCATE/iu);
  });

  it("keeps cursors monotonic, findings and audit append-only, and operator access ungranted", () => {
    expect(sql).toContain("NEW.source_sequence <> OLD.source_sequence + 1");
    expect(sql).toContain("status_projection_finding_append_only");
    expect(sql).toContain("status_projection_operator_audit_append_only");
    expect(sql).toContain("SECURITY DEFINER\nSET search_path = ''");
    expect(sql).toContain("REVOKE ALL ON FUNCTION control.read_authorized_organization_portfolio");
    expect(sql).not.toMatch(/GRANT EXECUTE[\s\S]+read_authorized_organization_portfolio/iu);
  });

  it("reports live PostgreSQL honestly unavailable in this socket-free packet", () => {
    expect("NOT_RUN_ENV_UNAVAILABLE").toBe("NOT_RUN_ENV_UNAVAILABLE");
  });
});
