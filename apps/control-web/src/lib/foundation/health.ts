import {
  FOUNDATION_SCHEMA,
  type DependencyStatus,
  type ServiceHealth,
} from "./contracts";

const REQUIRED_WEB = new Set([
  "audit-append",
  "contract-lock",
  "issuer-registry",
  "owned-store",
  "session-entropy",
  "tenant-transaction",
]);

export interface DependencyProbe {
  readonly name: string;
  readonly required: boolean;
  readonly check: () => Promise<"READY" | "DEGRADED" | "NOT_READY">;
}

export function liveness(): ServiceHealth {
  return {
    schemaVersion: FOUNDATION_SCHEMA,
    service: "control-web",
    state: "RUNNING",
    dependencies: [],
  };
}

export function readiness(dependencies: readonly DependencyStatus[]): ServiceHealth {
  const names = new Set(dependencies.map((item) => item.name));
  const complete = [...REQUIRED_WEB].every((name) => names.has(name));
  const requiredReady = dependencies.every((item) => !item.required || item.state === "READY");
  return {
    schemaVersion: FOUNDATION_SCHEMA,
    service: "control-web",
    state: complete && requiredReady ? "READY" : "NOT_READY",
    dependencies: [...dependencies].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export function localReadyDependencies(now = "2026-01-01T00:00:00Z"): readonly DependencyStatus[] {
  return [...REQUIRED_WEB, "telemetry"].sort().map((name) => ({
    name,
    required: name !== "telemetry",
    state: name === "telemetry" ? "DEGRADED" : "READY",
    reasonCode: name === "telemetry" ? "OPTIONAL_DISABLED" : "LOCAL_FIXTURE_READY",
    observedAt: now,
  }));
}

export async function evaluateProbes(
  probes: readonly DependencyProbe[],
  now: string,
  timeoutMilliseconds = 100,
): Promise<readonly DependencyStatus[]> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 1_000) {
    throw new Error("PROBE_TIMEOUT_INVALID");
  }
  return Promise.all(probes.map(async (probe): Promise<DependencyStatus> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        probe.check(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("PROBE_TIMEOUT")), timeoutMilliseconds);
        }),
      ]);
      return {
        name: probe.name,
        required: probe.required,
        state,
        reasonCode: state === "READY" ? "PROBE_READY" : "PROBE_NOT_READY",
        observedAt: now,
      };
    } catch (error) {
      return {
        name: probe.name,
        required: probe.required,
        state: "NOT_READY",
        reasonCode: error instanceof Error && error.message === "PROBE_TIMEOUT" ? "PROBE_TIMEOUT" : "PROBE_FAILED",
        observedAt: now,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
