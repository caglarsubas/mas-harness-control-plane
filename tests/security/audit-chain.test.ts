import { describe, expect, it } from "vitest";

import {
  AUDIT_GENESIS_DIGEST,
  TenantAuditChain,
  verifyAuditChain,
  type AuditChainRecord,
  type AuditableFact,
} from "../../apps/control-web/src/lib/security/audit-chain";

const ORGANIZATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function fact(index: number, organizationId = ORGANIZATION): AuditableFact {
  return Object.freeze({
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    organizationId,
    eventType: `control.audit-${index}.v1`,
    aggregateDigest: `sha256:${String(index).repeat(64).slice(0, 64)}`,
    actorDigest: `sha256:${String(index + 3).repeat(64).slice(0, 64)}`,
    occurredAt: `2026-09-02T11:3${index}:00Z`,
  });
}

function changed(records: readonly AuditChainRecord[], index: number, change: Partial<AuditChainRecord>): AuditChainRecord[] {
  return records.map((record, offset) => offset === index ? ({ ...record, ...change } as AuditChainRecord) : record);
}

describe("tenant audit chain", () => {
  it("creates independent monotonic tenant chains with a deterministic genesis", () => {
    const chain = new TenantAuditChain();
    chain.append([fact(1), fact(2)]);
    chain.append([fact(3)]);
    chain.append([fact(4, OTHER)]);
    const records = chain.records(ORGANIZATION);
    expect(records).toHaveLength(3);
    expect(records[0].previousRecordDigest).toBe(AUDIT_GENESIS_DIGEST);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(chain.verification(ORGANIZATION)).toEqual({
      valid: true,
      reasonCode: "AUDIT_CHAIN_VALID",
      verifiedLength: 3,
      headDigest: records[2].recordDigest,
    });
    expect(chain.records(OTHER)).toHaveLength(1);
  });

  it("detects changed, reordered, deleted, inserted, and predecessor-tampered records", () => {
    const chain = new TenantAuditChain();
    chain.append([fact(1), fact(2), fact(3)]);
    const records = chain.records(ORGANIZATION);
    const vectors: readonly AuditChainRecord[][] = [
      changed(records, 1, { aggregateDigest: `sha256:${"f".repeat(64)}` }),
      [records[1]!, records[0]!, records[2]!],
      [records[0]!, records[2]!],
      [records[0]!, { ...records[1]!, eventId: "99999999-9999-4999-8999-999999999999" }, records[1]!, records[2]!],
      changed(records, 2, { previousRecordDigest: AUDIT_GENESIS_DIGEST }),
      changed(records, 0, { organizationId: OTHER }),
    ];
    for (const vector of vectors) {
      expect(verifyAuditChain(ORGANIZATION, vector).valid).toBe(false);
      expect(verifyAuditChain(ORGANIZATION, vector).reasonCode).toBe("AUDIT_CHAIN_TAMPERED");
    }
  });

  it("refuses duplicate events and mixed-tenant batches without partial append", () => {
    const chain = new TenantAuditChain();
    chain.append([fact(1)]);
    expect(() => chain.append([fact(1)])).toThrowError("AUDIT_CHAIN_DUPLICATE_EVENT");
    expect(() => chain.append([fact(2), fact(3, OTHER)])).toThrowError("AUDIT_CHAIN_FACT_REFUSED");
    expect(chain.records(ORGANIZATION)).toHaveLength(1);
    expect(chain.records(OTHER)).toHaveLength(0);
  });
});
