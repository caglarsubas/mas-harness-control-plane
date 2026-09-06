# Tenant harness status projections

Status projections are control-owned, append/update-only read models for the
tenant overview, plane pages, harness pages, and separately authorized operator
portfolio. Browsers read these projections only; they never fan out to runtime,
knowledge, execution, trust, operator, or distribution services.

## Immutable current-state binding

Every non-empty tenant, plane, harness, axis, finding, or freshness response is
bound to all of the following:

- `organizationId`;
- `profileDigest`, `bundleDigest`, and `releaseDigest`;
- positive `observedGeneration`;
- `projectedAt` and `freshUntil`;
- at least one authenticated source cursor;
- `harness.planeon.ai/status-projection/v1alpha1`.

A missing binding is not renderable as current. The one exception is an
explicit empty-organization overview: `empty=true`, `binding=null`,
`freshness=null`, `aggregateState=EMPTY`, and no plane/harness rows. It cannot be
mistaken for a healthy tenant.

## Closed state dimensions

Selection is one of `NOT_SELECTED`, `PROPOSED`, `SELECTED`, or `BLOCKED`.
Installation uses the sixteen lifecycle states from `ABSENT` through
`REVOKED`. Evidence is independently projected for exactly eleven axes:

```text
SOURCE CONTRACT_UNIT PR_CHECK MERGE ARTIFACT_SBOM SIGNATURE_RELEASE
DEPLOYMENT RUNTIME SECURITY ASSURANCE TENANT_ACCEPTANCE
```

Each axis state is `NOT_APPLICABLE`, `MISSING`, `COLLECTING`, `PASS`, `WARN`,
`FAIL`, `STALE`, `WAIVED`, or `NOT_RUN_ENV_UNAVAILABLE`. Freshness is `CURRENT`,
`STALE`, or `SOURCE_UNAVAILABLE`. Aggregate health is `EMPTY`, `READY`,
`DEGRADED`, `BLOCKED`, `FAILED`, or `REVOKED`.

`WAIVED` requires a digest-bound approval plus the retained underlying non-pass
state. `PASS` and `NOT_APPLICABLE` cannot be hidden under a waiver. A waiver
contributes `DEGRADED`, never `PASS`.

## Deterministic aggregation

Aggregation consumes a complete snapshot; it does not fold events in arrival
order. Harness IDs and axes must be unique. Only `SELECTED` and selection-
`BLOCKED` harnesses contribute. `NOT_SELECTED` and `PROPOSED` remain visible but
cannot improve or degrade health.

Precedence is:

1. a selected `REVOKED` installation yields `REVOKED`;
2. a selected `FAILED` installation or required `FAIL` axis yields `FAILED`;
3. selection `BLOCKED`, any selected non-ready installation other than
   `DEGRADED`, a required missing/collecting/stale/unavailable axis, or stale or
   unavailable projection freshness yields `BLOCKED`;
4. selected `DEGRADED`, required `WARN`, any optional non-pass axis, or any
   valid waiver yields `DEGRADED`;
5. `READY` requires every selected installation ready, every required axis
   fresh `PASS` or contractually `NOT_APPLICABLE`, and current projection
   freshness;
6. no contributing harnesses yields `EMPTY`.

The worst installation state uses a published total precedence only for display
and explanation. It does not replace the aggregate rules above. Results include
lexically sorted contributing harness IDs and exact selection/installation
counts, so the UI can explain every aggregate without an opaque score.

## Public response kinds

- `OrganizationHarnessPortfolioPage` is cursor-paginated, capped at 200, and
  fixed to `PLATFORM_OPERATOR` scope. Each item carries its own organization
  binding.
- `TenantHarnessOverview` contains four plane summaries and sixteen harness
  summaries when non-empty.
- `PlaneStatusProjection` contains exactly four canonical harness summaries.
- `HarnessStatusProjection` contains ownership, selected modules/providers,
  generations, immutable releases, all eleven evidence axes, dependencies,
  findings, stable reason codes, and permitted next-action codes.
- `StatusAxisProjection`, `StatusFindingSummary`, and `ProjectionFreshness`
  expose independently addressable, binding-safe response forms.

Tenant APIs never accept an organization/tenant header:

```text
GET /api/v1alpha1/overview
GET /api/v1alpha1/planes/{planeId}
GET /api/v1alpha1/harnesses/{harnessId}
```

The platform-operator portfolio is a separate policy surface:

```text
GET /api/v1alpha1/organizations?cursor=&limit=&state=
GET /api/v1alpha1/organizations/{organizationId}/overview
```

Unauthorized organization IDs return the same not-found response as absent
ones and create an audit event in the implementing service. This contracts
repository owns no authentication implementation or store.

## Freshness and outage behavior

`CURRENT` requires the projection time to remain inside `freshUntil` and every
required source cursor to be current. When a producer is late or unavailable,
the last verified projection may still be served, but its freshness becomes
`STALE` or `SOURCE_UNAVAILABLE`; a healthy aggregate is prohibited. Projection
loss never triggers browser fan-out or a write. Mutations remain fail closed in
the implementing service.

All contracts and generated assets are local and deterministic. They require no
cloud service, API key, hosted runner, remote cache, external telemetry, runtime
download, or public browser request.
