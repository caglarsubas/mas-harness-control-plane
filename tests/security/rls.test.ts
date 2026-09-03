import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { tenantContextStatement } from "../../packages/db/tenant-context";

const MIGRATIONS = join(process.cwd(), "packages/db/migrations");

function sqlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sqlFiles(path) : entry.isFile() && entry.name.endsWith(".sql") ? [path] : [];
  }).sort();
}

describe("cumulative PostgreSQL tenant boundary", () => {
  it("gives every tenant-owned control table FORCE RLS and a transaction-local tenant policy", () => {
    const sources = sqlFiles(MIGRATIONS).map((path) => readFileSync(path, "utf8"));
    const all = sources.join("\n");
    const tables = [...all.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1]!);
    const globalTables = ["status_projection_operator_audit"];
    const tenantTables = tables.filter((table) => !globalTables.includes(table));
    expect(tables.length).toBeGreaterThan(20);
    expect(new Set(tables).size).toBe(tables.length);
    expect(tables.filter((table) => globalTables.includes(table))).toEqual(globalTables);
    for (const table of tenantTables) {
      expect(all).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(all).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(`CREATE POLICY [a-z_]+ ON control\\.${table}\\s+USING \\(organization_id = control\\.current_organization_id\\(\\)\\)\\s+WITH CHECK \\(organization_id = control\\.current_organization_id\\(\\)\\);`, "u");
      expect(all).toMatch(policy);
    }
    expect(all).not.toMatch(/GRANT[^;]*\b(?:DELETE|TRUNCATE|BYPASSRLS)\b/gu);
    expect(all).toContain("REVOKE DELETE, TRUNCATE");
  });

  it("keeps the platform operator audit global, append-only, and inaccessible to runtime roles", () => {
    const all = sqlFiles(MIGRATIONS).map((path) => readFileSync(path, "utf8")).join("\n");
    const auditTable = all.match(/CREATE TABLE control\.status_projection_operator_audit \(([\s\S]*?)\n\);/u)?.[1];
    expect(auditTable).toBeDefined();
    expect(auditTable).not.toContain("organization_id");
    expect(all).not.toContain("ALTER TABLE control.status_projection_operator_audit ENABLE ROW LEVEL SECURITY;");
    expect(all).not.toContain("ALTER TABLE control.status_projection_operator_audit FORCE ROW LEVEL SECURITY;");
    expect(all).not.toMatch(/CREATE POLICY [a-z_]+ ON control\.status_projection_operator_audit/u);
    expect(all).toContain("status_projection_operator_audit_append_only");
    expect(all).toContain("REVOKE ALL ON control.status_projection_operator_audit FROM PUBLIC, control_runtime, control_compiler_worker, control_event_publisher;");
    expect(all).not.toMatch(/GRANT[^;]*ON control\.status_projection_operator_audit/gu);
  });

  it("uses one parameterized transaction-local tenant context statement", () => {
    const statement = tenantContextStatement("11111111-1111-4111-8111-111111111111");
    expect(statement).toEqual({
      text: "SELECT set_config('planeon.organization_id', $1, true)",
      values: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(() => tenantContextStatement("' OR true --")).toThrowError("TENANT_CONTEXT_REFUSED");
  });
});
