import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve("packages/db/migrations/profile-lock/005_profile_lock.sql"), "utf8");

describe("CTRL-005 additive PostgreSQL migration", () => {
  it("creates exactly the three packet-owned tables", () => {
    expect([...migration.matchAll(/CREATE TABLE control\.([a-z_]+)/gu)].map((match) => match[1])).toEqual([
      "profile_approval", "profile_lock", "bundle_request",
    ]);
  });

  it.each(["profile_approval", "profile_lock", "bundle_request"])("forces tenant RLS and append-only or guarded mutation on %s", (table) => {
    expect(migration).toContain(`ALTER TABLE control.${table} FORCE ROW LEVEL SECURITY;`);
    expect(migration).toContain(`CREATE POLICY ${table}_isolation ON control.${table}`);
    expect(migration).toContain("organization_id = control.current_organization_id()");
  });

  it("replaces only the named compatible state constraints and guards legal transitions", () => {
    expect(migration).toContain("DROP CONSTRAINT profile_state_check");
    expect(migration).toContain("DROP CONSTRAINT operation_operation_type_check");
    expect(migration).toContain("'BUILD_BUNDLE'");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION control.guard_profile_pointer()");
    expect(migration).toContain("OLD.state = 'PROPOSED' AND NEW.state = 'APPROVAL_PENDING'");
    expect(migration).toContain("OLD.state = 'APPROVAL_PENDING' AND NEW.state IN ('LOCKED', 'REJECTED')");
  });

  it("uses uniqueness, immutable locks, constrained grants, and no destructive down migration", () => {
    expect(migration).toContain("UNIQUE (organization_id, profile_pk)");
    expect(migration).toContain("CREATE TRIGGER profile_lock_append_only");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON control.profile_lock");
    expect(migration).toContain("REVOKE DELETE, TRUNCATE");
    expect(migration).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM/u);
    expect(migration).not.toContain("BYPASSRLS");
  });
});
