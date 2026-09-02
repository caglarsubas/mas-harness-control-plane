import { describe, expect, it } from "vitest";

import { STATUS_AUTHORITY } from "../../apps/control-web/src/lib/harness-status/authority";
import { EVIDENCE_AXES, INSTALLATION_STATES, SOURCE_IDS } from "../../apps/control-web/src/lib/harness-status/contracts";
import { HARNESSES, HARNESS_IDS, PLANES } from "../../apps/control-web/src/lib/harness-status/taxonomy";

describe("CTRL-007 authority and taxonomy", () => {
  it("pins exact CON-005 and predecessor evidence without a runtime checkout", () => {
    expect(STATUS_AUTHORITY.contractCommit).toBe("63a1af44ce0abe31075c37c3529848ebe8fe2fcb");
    expect(STATUS_AUTHORITY.statusSemanticsSha256).toBe("ab0dca30d0411c6f5897652e044ef3ad732f5feba7c4852bdca111b2112f844f");
    expect(Object.values(STATUS_AUTHORITY.predecessors).every((item) => /^[0-9a-f]{40}$/u.test(item.commit) && item.prRun > 0 && item.mainRun > 0)).toBe(true);
    expect(EVIDENCE_AXES).toHaveLength(11);
    expect(INSTALLATION_STATES).toHaveLength(16);
    expect(SOURCE_IDS).toHaveLength(8);
  });

  it("keeps exactly four ordered planes and sixteen named canonical harnesses", () => {
    expect(PLANES.map((plane) => plane.id)).toEqual(["runtime", "knowledge", "execution", "trust"]);
    expect(PLANES.every((plane) => plane.harnesses.length === 4)).toBe(true);
    expect(HARNESSES.map((harness) => harness.number)).toEqual([...Array(16)].map((_, index) => index + 1));
    expect(new Set(HARNESS_IDS).size).toBe(16);
    expect(HARNESS_IDS).toContain("runtime.experience");
    expect(HARNESS_IDS).toContain("execution.tool-skill-sandbox");
    expect(HARNESS_IDS).toContain("trust.evaluation-assurance");
  });
});
