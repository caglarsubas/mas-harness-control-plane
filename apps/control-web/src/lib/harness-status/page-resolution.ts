import type { HarnessStatusProjection, PlaneStatusProjection } from "./contracts";
import { createFixtureProjectionSet, FIXTURE_ORGANIZATION_ID, type FixtureProjectionSet } from "./fixtures";
import { harnessDefinition, planeDefinition } from "./taxonomy";

// Preview composition: page destinations resolve existence synchronously, before any Suspense boundary streams.
export function resolveOrganizationProjection(organizationId: string): FixtureProjectionSet | null {
  if (organizationId === FIXTURE_ORGANIZATION_ID) return createFixtureProjectionSet();
  if (organizationId === "org.copper-ridge-labs") return createFixtureProjectionSet(organizationId, "Copper Ridge Materials Lab");
  return null;
}

export function resolveHarnessProjection(harnessId: string): HarnessStatusProjection | null {
  if (!harnessDefinition(harnessId)) return null;
  return createFixtureProjectionSet().harnesses.find((item) => item.spec.harnessId === harnessId) ?? null;
}

export function resolvePlaneProjection(planeId: string): PlaneStatusProjection | null {
  if (!planeDefinition(planeId)) return null;
  return createFixtureProjectionSet().planes.find((item) => item.spec.planeId === planeId) ?? null;
}
