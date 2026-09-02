import { canonicalJson, sha256 } from "../foundation/canonical";
import { ControlError } from "../foundation/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EVENT_TYPE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u;
const RFC3339 = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;

export const AUDIT_CHAIN_SCHEMA = "planeon.control.audit-chain/v1" as const;
export const AUDIT_GENESIS_DIGEST = sha256("");

export interface AuditableFact {
  readonly eventId: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateDigest: string;
  readonly actorDigest: string;
  readonly occurredAt: string;
}

export interface AuditChainRecord extends AuditableFact {
  readonly schemaVersion: typeof AUDIT_CHAIN_SCHEMA;
  readonly sequence: number;
  readonly previousRecordDigest: string;
  readonly recordDigest: string;
}

export interface AuditChainVerification {
  readonly valid: boolean;
  readonly reasonCode: "AUDIT_CHAIN_VALID" | "AUDIT_CHAIN_TAMPERED";
  readonly verifiedLength: number;
  readonly headDigest: string;
}

function validateFact(fact: AuditableFact, organizationId?: string): void {
  if (
    !UUID.test(fact.eventId) || !UUID.test(fact.organizationId) ||
    (organizationId !== undefined && fact.organizationId !== organizationId) ||
    !EVENT_TYPE.test(fact.eventType) || !SHA256.test(fact.aggregateDigest) ||
    !SHA256.test(fact.actorDigest) || !RFC3339.test(fact.occurredAt) ||
    Object.keys(fact).some((key) => ![
      "schemaVersion", "sequence", "previousRecordDigest", "recordDigest", "eventId", "organizationId",
      "eventType", "aggregateId", "aggregateDigest", "actorDigest", "occurredAt",
    ].includes(key))
  ) {
    throw new ControlError("AUDIT_CHAIN_FACT_REFUSED", 422);
  }
}

function digest(record: Omit<AuditChainRecord, "recordDigest">): string {
  return sha256(canonicalJson(record));
}

export function verifyAuditChain(organizationId: string, records: readonly AuditChainRecord[]): AuditChainVerification {
  let previous = AUDIT_GENESIS_DIGEST;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    try {
      validateFact(record, organizationId);
    } catch {
      return Object.freeze({ valid: false, reasonCode: "AUDIT_CHAIN_TAMPERED", verifiedLength: index, headDigest: previous });
    }
    const { recordDigest: supplied, ...unsigned } = record;
    if (
      record.schemaVersion !== AUDIT_CHAIN_SCHEMA || record.sequence !== index + 1 ||
      record.previousRecordDigest !== previous || !SHA256.test(supplied) || digest(unsigned) !== supplied ||
      records.slice(0, index).some((candidate) => candidate.eventId === record.eventId)
    ) {
      return Object.freeze({ valid: false, reasonCode: "AUDIT_CHAIN_TAMPERED", verifiedLength: index, headDigest: previous });
    }
    previous = supplied;
  }
  return Object.freeze({ valid: true, reasonCode: "AUDIT_CHAIN_VALID", verifiedLength: records.length, headDigest: previous });
}

export class TenantAuditChain {
  private readonly recordsByTenant = new Map<string, readonly AuditChainRecord[]>();

  append(facts: readonly AuditableFact[]): readonly AuditChainRecord[] {
    if (facts.length < 1 || facts.length > 32) throw new ControlError("AUDIT_CHAIN_BATCH_REFUSED", 422);
    const organizationId = facts[0]!.organizationId;
    const current = this.recordsByTenant.get(organizationId) ?? Object.freeze([]);
    if (!verifyAuditChain(organizationId, current).valid) throw new ControlError("AUDIT_CHAIN_TAMPERED", 503);
    const seen = new Set(current.map((record) => record.eventId));
    const appended: AuditChainRecord[] = [];
    let previous = current.at(-1)?.recordDigest ?? AUDIT_GENESIS_DIGEST;
    for (const fact of facts) {
      validateFact(fact, organizationId);
      if (seen.has(fact.eventId)) throw new ControlError("AUDIT_CHAIN_DUPLICATE_EVENT", 409);
      seen.add(fact.eventId);
      const unsigned = Object.freeze({
        schemaVersion: AUDIT_CHAIN_SCHEMA,
        sequence: current.length + appended.length + 1,
        previousRecordDigest: previous,
        eventId: fact.eventId,
        organizationId: fact.organizationId,
        eventType: fact.eventType,
        aggregateDigest: fact.aggregateDigest,
        actorDigest: fact.actorDigest,
        occurredAt: fact.occurredAt,
      });
      const record = Object.freeze({ ...unsigned, recordDigest: digest(unsigned) });
      appended.push(record);
      previous = record.recordDigest;
    }
    const replacement = Object.freeze([...current, ...appended]);
    if (!verifyAuditChain(organizationId, replacement).valid) throw new ControlError("AUDIT_CHAIN_TAMPERED", 503);
    this.recordsByTenant.set(organizationId, replacement);
    return Object.freeze(appended);
  }

  records(organizationId: string): readonly AuditChainRecord[] {
    return Object.freeze([...(this.recordsByTenant.get(organizationId) ?? [])]);
  }

  verification(organizationId: string): AuditChainVerification {
    return verifyAuditChain(organizationId, this.records(organizationId));
  }
}
