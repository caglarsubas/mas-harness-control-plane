import { describe, expect, it } from "vitest";

import { createFixtureProjectionSet, FIXTURE_ORGANIZATION_ID } from "../../apps/control-web/src/lib/harness-status/fixtures";
import { resolveHarnessProjection, resolveOrganizationProjection, resolvePlaneProjection } from "../../apps/control-web/src/lib/harness-status/page-resolution";

const fixture = createFixtureProjectionSet();

describe("page destination resolvers", () => {
  it("resolves both fixture organisations and nothing else", () => {
    expect(resolveOrganizationProjection(FIXTURE_ORGANIZATION_ID)).toEqual(fixture);
    expect(resolveOrganizationProjection("org.copper-ridge-labs")).toEqual(createFixtureProjectionSet("org.copper-ridge-labs", "Copper Ridge Materials Lab"));
    for (const id of ["org.does-not-exist", "", "org.unknown-tenant"]) expect(resolveOrganizationProjection(id), id).toBeNull();
    expect(resolveOrganizationProjection("org.unknown-tenant")).toBe(resolveOrganizationProjection("org.does-not-exist"));
  });

  it("resolves every fixture harness and refuses unknown ids", () => {
    expect(fixture.harnesses.length).toBeGreaterThan(0);
    for (const projection of fixture.harnesses) expect(resolveHarnessProjection(projection.spec.harnessId), projection.spec.harnessId).toEqual(projection);
    for (const id of ["knowledge.unknown-harness", "", "org.unknown-tenant"]) expect(resolveHarnessProjection(id), id).toBeNull();
  });

  it("resolves every fixture plane and refuses unknown ids", () => {
    expect(fixture.planes.length).toBeGreaterThan(0);
    for (const projection of fixture.planes) expect(resolvePlaneProjection(projection.spec.planeId), projection.spec.planeId).toEqual(projection);
    for (const id of ["plane.unknown", "", "org.unknown-tenant"]) expect(resolvePlaneProjection(id), id).toBeNull();
  });
});
