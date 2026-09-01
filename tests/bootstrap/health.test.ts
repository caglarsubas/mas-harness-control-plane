import { describe, expect, it } from "vitest";

import { GET as live } from "../../apps/control-web/src/app/health/live/route";
import { GET as defaultReady, readinessResponse } from "../../apps/control-web/src/app/health/ready/route";
import { evaluateProbes, localReadyDependencies, readiness } from "../../apps/control-web/src/lib/foundation/health";

describe("closed health state", () => {
  it("reports bounded liveness and readiness without tenant or environment data", async () => {
    const liveResponse = live();
    const readyResponse = readinessResponse(localReadyDependencies());
    expect(liveResponse.status).toBe(200);
    expect(readyResponse.status).toBe(200);
    expect(await liveResponse.json()).toEqual({
      schemaVersion: "planeon.control.foundation/v1",
      service: "control-web",
      state: "RUNNING",
      dependencies: [],
    });
    expect(JSON.stringify(await readyResponse.json())).not.toMatch(/token|cookie|password|secret/iu);
    expect(defaultReady().status).toBe(503);
  });

  it("fails readiness when a required dependency is missing or not ready while telemetry may degrade", () => {
    const all = localReadyDependencies();
    expect(readiness(all).state).toBe("READY");
    expect(readiness(all.filter((item) => item.name !== "owned-store")).state).toBe("NOT_READY");
    expect(readiness(all.map((item) => item.name === "owned-store" ? { ...item, state: "NOT_READY" as const } : item)).state).toBe("NOT_READY");
    expect(readiness(all.map((item) => item.name === "telemetry" ? { ...item, state: "DEGRADED" as const } : item)).state).toBe("READY");
  });

  it("converts probe exceptions and timeouts to bounded not-ready evidence", async () => {
    const results = await evaluateProbes([
      { name: "exception", required: true, check: async () => { throw new Error("sensitive exception"); } },
      { name: "timeout", required: true, check: () => new Promise(() => undefined) },
    ], "2026-01-01T00:00:00Z", 5);
    expect(results.map((item) => item.reasonCode)).toEqual(["PROBE_FAILED", "PROBE_TIMEOUT"]);
    expect(JSON.stringify(results)).not.toContain("sensitive exception");
  });
});
