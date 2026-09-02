import { ControlError } from "./contracts";

const ALLOWED = new Set([
  "harness.organization.id",
  "harness.id",
  "harness.plane.id",
  "harness.component.name",
  "harness.operation.name",
  "harness.operation.outcome",
  "harness.correlation.id",
]);

const VALUE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u;

export function neutralAttributes(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(input);
  if (entries.length > ALLOWED.size) throw new ControlError("TELEMETRY_ATTRIBUTE_REFUSED");
  for (const [key, value] of entries) {
    if (!ALLOWED.has(key) || !VALUE.test(value)) throw new ControlError("TELEMETRY_ATTRIBUTE_REFUSED");
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}
