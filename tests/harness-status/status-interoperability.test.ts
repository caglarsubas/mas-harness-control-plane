import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deriveHarnessAggregate, highestEvidenceState, planeSummary } from "../../apps/control-web/src/lib/harness-status/aggregation";
import { EVIDENCE_AXES, EVIDENCE_STATES, FRESHNESS_STATES, INSTALLATION_STATES, SELECTION_STATES, type AggregateState, type FreshnessState, type HarnessSummary, type InstallationState, type SelectionState, type StatusAxisProjection } from "../../apps/control-web/src/lib/harness-status/contracts";
import vectors from "../../contracts/status-regression/aggregation-interoperability.json";

const ROOT = new URL("../../contracts/status-regression/", import.meta.url);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const pins = {
  "aggregation-interoperability.json": "4cfd71c300ccb2209a52d00230711820a0da52faea5169b86f5db1d3638d56bc",
  "release-manifest.json": "c2e6976aac3b63d7152943c0ff73b332a297081e376f6abc3f3ee3a9371a6b25",
  "status-projections.md": "b9e074ccb056baa79f9617f9da203797fa481a81a8125e773101d147db4c261b",
  "status-semantics.json": "ab0dca30d0411c6f5897652e044ef3ad732f5feba7c4852bdca111b2112f844f",
};

interface Input {
  harnessId: string;
  selectionState: string;
  installationState: string;
  axisOverrides?: Record<string, { state: string; required: boolean; underlyingState?: string | null }>;
}

function axes(input: Input): readonly StatusAxisProjection[] {
  return EVIDENCE_AXES.map((axis) => {
    const override = input.axisOverrides?.[axis];
    const state = (override?.state ?? "PASS") as StatusAxisProjection["state"];
    return {
      axis, required: override?.required ?? true, state,
      underlyingState: (override?.underlyingState ?? (state === "WAIVED" ? "FAIL" : null)) as StatusAxisProjection["underlyingState"],
      observedAt: "2030-01-01T00:00:00Z", evidenceRefs: [],
      waiver: state === "WAIVED" ? { waiverId: "waiver.regression", waiverDigest: `sha256:${"a".repeat(64)}`, approvedBy: "operator.regression", expiresAt: "2030-02-01T00:00:00Z", basisCode: "APPROVED_EXCEPTION" } : null,
      applicability: state === "NOT_APPLICABLE" ? { reasonCode: "AXIS_NOT_REQUIRED", contractRef: { apiVersion: "harness.planeon.ai/v1alpha1", kind: "resource.contract", id: "contract.axis-applicability", digest: `sha256:${"a".repeat(64)}` } } : null,
    };
  });
}

function summary(input: Input, state: FreshnessState): HarnessSummary {
  const evidence = axes(input);
  const before = structuredClone(evidence);
  const selectionState = input.selectionState as SelectionState;
  const installationState = input.installationState as InstallationState;
  const aggregateState = deriveHarnessAggregate(selectionState, installationState, evidence, {
    state, projectedAt: "2030-01-01T00:00:00Z", freshUntil: "2030-01-02T00:00:00Z", sourceCursors: [],
  });
  expect(evidence).toEqual(before);
  return { harnessId: input.harnessId, planeId: "runtime", selectionState, installationState,
    aggregateState, highestEvidenceState: highestEvidenceState(evidence), freshnessState: state,
    blockerCount: 0, reasonCode: "INDEPENDENT_VECTOR" };
}

function assertScenario(harnesses: Input[], freshness: FreshnessState, expected: Record<string, unknown>): void {
  const original = structuredClone(harnesses);
  const summaries = harnesses.map((input) => summary(input, freshness));
  const plane = planeSummary("runtime", summaries);
  const selected = summaries.filter((item) => item.selectionState === "SELECTED" || item.selectionState === "BLOCKED");
  const counts = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]));
  // This adapter only exposes facts from real TypeScript summaries. Expected
  // outputs are always the byte-pinned, hand-authored predecessor vector values.
  const actual: Record<string, unknown> = {
    aggregateState: plane.aggregateState, selectedCount: plane.selectedCount,
    worstInstallationState: plane.worstInstallationState,
    selectionCounts: counts(summaries.map((item) => item.selectionState)),
    installationCounts: counts(selected.map((item) => item.installationState)),
    contributingHarnessIds: harnesses.map((input) => summary(input, "CURRENT"))
      .filter((item) => item.aggregateState !== "EMPTY" && item.aggregateState !== "READY")
      .map((item) => item.harnessId).sort(),
  };
  for (const [key, value] of Object.entries(expected)) expect(actual[key], key).toEqual(value);
  expect(harnesses).toEqual(original);
}

describe("digest-pinned CON-FIX-001 independent status regression", () => {
  it("binds the exact merged source, manifest role, bytes and unchanged canonical dimensions", () => {
    const lock = JSON.parse(readFileSync(new URL("source-lock.json", ROOT), "utf8"));
    expect(lock.sourceCommit).toBe("fb365aabfd8c5560e064be5d97ff9f2bcc69c57c");
    expect(lock.repository).toBe("caglarsubas/mas-harness-contracts");
    expect(lock.sourcePacketId).toBe("CON-FIX-001");
    expect(lock.runtimeAcceptance).toBe(false);
    expect(lock.files.map((item: {path: string}) => item.path).sort()).toEqual(Object.keys(pins).sort());
    const manifest = JSON.parse(readFileSync(new URL("release-manifest.json", ROOT), "utf8"));
    expect(manifest.extensionPacketIds).toEqual(["CON-007", "CON-FIX-001"]);
    for (const [path, sha256] of Object.entries(pins)) {
      expect(digest(readFileSync(new URL(path, ROOT))), path).toBe(sha256);
      const entry = lock.files.find((item: {path: string}) => item.path === path);
      expect(entry.sha256).toBe(sha256);
      if (path !== "release-manifest.json") {
        const matches = manifest.entries.filter((item: {path: string}) => item.path === entry.sourcePath);
        expect(matches).toHaveLength(1);
        expect(matches[0].sha256).toBe(`sha256:${sha256}`);
        if (path === "aggregation-interoperability.json") expect(matches[0].role).toBe("INDEPENDENT_CONTRACT_VECTOR");
      }
    }
    expect(vectors.evidenceClassification).toBe("INDEPENDENT_CONTRACT_VECTOR");
    expect(vectors.authority.documentSha256).toBe(pins["status-projections.md"]);
    expect(vectors.authority.semanticsSha256).toBe(pins["status-semantics.json"]);
    expect(vectors.axisIds).toEqual(EVIDENCE_AXES);
    expect(vectors.installationColumns).toEqual(INSTALLATION_STATES);
    expect(Object.keys(vectors.selectionInstallationExpected)).toEqual(SELECTION_STATES);
    expect(Object.keys(vectors.freshnessExpected)).toEqual(FRESHNESS_STATES);
    expect(vectors.evidenceExpected.map((item) => item.state)).toEqual(EVIDENCE_STATES);
  });

  for (const [selectionState, row] of Object.entries(vectors.selectionInstallationExpected)) {
    for (const [index, installationState] of vectors.installationColumns.entries()) {
      for (const freshness of FRESHNESS_STATES) {
        it(`${selectionState}/${installationState}/${freshness}`, () => {
          const expected = vectors.freshnessExpected[freshness][row[index] as AggregateState];
          assertScenario([{ harnessId: "runtime.infrastructure", selectionState, installationState }], freshness, { aggregateState: expected });
        });
      }
    }
  }
  for (const axis of EVIDENCE_AXES) {
    for (const required of [true, false]) {
      for (const row of vectors.evidenceExpected) {
        it(`${axis}/${required ? "required" : "optional"}/${row.state}`, () => {
          assertScenario([{ harnessId: "runtime.infrastructure", selectionState: "SELECTED", installationState: "READY",
            axisOverrides: { [axis]: { state: row.state, required } } }], "CURRENT", { aggregateState: row[required ? "required" : "optional"] });
        });
      }
      for (const underlyingState of vectors.waiverUnderlyingStates) {
        it(`${axis}/${required}/waiver-retains-${underlyingState}`, () => {
          assertScenario([{ harnessId: "runtime.infrastructure", selectionState: "SELECTED", installationState: "READY",
            axisOverrides: { [axis]: { state: "WAIVED", required, underlyingState } } }], "CURRENT", { aggregateState: vectors.waiverExpected });
        });
      }
    }
  }
  for (const scenario of vectors.scenarios) {
    it(scenario.id, () => assertScenario(scenario.harnesses, scenario.freshnessState as FreshnessState, scenario.expected));
  }
  it("is invariant to input order and replay", () => {
    const scenario = vectors.scenarios.find((item) => item.id === "multi-harness-precedence-and-lexical-contributors")!;
    const permutations = (items: Input[]): Input[][] => items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map((tail) => [item, ...tail]));
    for (const ordering of permutations(scenario.harnesses)) {
      assertScenario(ordering, "CURRENT", scenario.expected);
      assertScenario(ordering, "CURRENT", scenario.expected);
    }
  });
  it("keeps full-suite acceptance in the exact additive descriptor", () => {
    const descriptor = JSON.parse(readFileSync(new URL("../../ci/targets/ctrl-fix-003.json", import.meta.url), "utf8"));
    expect(descriptor.targets).toEqual([{ name: "ctrl-fix-003-regression", acceptedVariables: {}, argvTemplate: [
      ["npm", "run", "typecheck"], ["npm", "run", "build"],
      ["node_modules/.bin/vitest", "run", "tests", "--pool=forks", "--sequence.concurrent=false"],
    ] }]);
  });
});
