import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { tenantContextStatement } from "../../packages/db/tenant-context";

const sql = readFileSync("packages/db/migrations/001_foundation.sql", "utf8");

describe("tenant-isolated database source contract", () => {
  it("uses parameterized transaction-local tenant context", () => {
    expect(tenantContextStatement("11111111-1111-4111-8111-111111111111")).toEqual({
      text: "SELECT set_config('planeon.organization_id', $1, true)",
      values: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(() => tenantContextStatement("'; reset role; --")).toThrowError(expect.objectContaining({ code: "TENANT_CONTEXT_REFUSED" }));
  });

  it("defines exactly the foundation tables with forced RLS and least privilege", () => {
    const tables = [...sql.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1]);
    expect(tables).toEqual([
      "tenant", "authorization_attempt", "auth_session", "auth_session_revision",
      "audit_event", "idempotency_record", "event_inbox", "event_outbox",
    ]);
    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE control.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY;`);
    }
    expect(sql).toContain("NULLIF(current_setting('planeon.organization_id', true), '')::uuid");
    expect(sql).toContain("NOLOGIN NOINHERIT NOBYPASSRLS");
    expect(sql).toContain("REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA control FROM control_runtime");
    expect(sql).not.toMatch(/DROP TABLE|DROP SCHEMA|CASCADE|CREATE DATABASE|CREATE EXTENSION/iu);
    expect(sql).not.toMatch(/questionnaire|demand|profile_revision|compilation_job|bundle_request|overview_projection/iu);
  });
});
