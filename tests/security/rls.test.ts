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
  it("gives every control table FORCE RLS and a transaction-local tenant policy", () => {
    const sources = sqlFiles(MIGRATIONS).map((path) => readFileSync(path, "utf8"));
    const all = sources.join("\n");
    const tables = [...all.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1]!);
    expect(tables.length).toBeGreaterThan(20);
    expect(new Set(tables).size).toBe(tables.length);
    for (const table of tables) {
      expect(all).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(all).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY;`);
      const policy = new RegExp(`CREATE POLICY [a-z_]+ ON control\\.${table}\\s+USING \\(organization_id = control\\.current_organization_id\\(\\)\\)\\s+WITH CHECK \\(organization_id = control\\.current_organization_id\\(\\)\\);`, "u");
      expect(all).toMatch(policy);
    }
    expect(all).not.toMatch(/GRANT[^;]*\b(?:DELETE|TRUNCATE|BYPASSRLS)\b/gu);
    expect(all).toContain("REVOKE DELETE, TRUNCATE");
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
