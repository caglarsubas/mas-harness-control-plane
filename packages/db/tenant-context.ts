import { ControlError } from "../../apps/control-web/src/lib/foundation/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SqlStatement {
  readonly text: string;
  readonly values: readonly string[];
}

export function tenantContextStatement(organizationId: string): SqlStatement {
  if (!UUID.test(organizationId)) throw new ControlError("TENANT_CONTEXT_REFUSED", 401);
  return Object.freeze({
    text: "SELECT set_config('planeon.organization_id', $1, true)",
    values: Object.freeze([organizationId]),
  });
}
