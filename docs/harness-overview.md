# Tenant harness overview

CTRL-007 adds the first evidence-led tenant overview for all four planes and all
sixteen canonical harnesses. It is an additive, read-only Alpha 1 surface. It
does not provision infrastructure, install a harness, refresh a source, approve
a waiver, certify assurance, or record tenant acceptance.

## Status and evidence boundary

The implementation consumes the exact public CON-005 status semantics pinned in
`apps/control-web/src/lib/harness-status/authority.ts`. Source code from the
contracts repository or any warm-start repository is neither mounted nor copied.
The local types reproduce the closed public values and the tests bind the exact
commit and file digests.

Aggregate precedence is `REVOKED > FAILED > BLOCKED > DEGRADED > READY > EMPTY`.
Only `SELECTED` and `BLOCKED` harnesses contribute. Required failure is failed;
missing, stale, unavailable, or not-run required evidence is blocked; warning or
a waiver is degraded. A waiver retains its underlying non-pass state. Proposed
and not-selected harnesses remain explanatory and cannot improve or degrade the
selected portfolio.

Source, contract/unit, pull-request check, merge, artifact/SBOM,
signature/release, deployment, runtime, security, assurance, and tenant
acceptance are eleven independent axes. The UI intentionally has no health
score.

## Runtime structure

The status module owns these closed pieces:

- `contracts.ts` — CON-005 enums and read models.
- `taxonomy.ts` — four ordered planes and sixteen named harnesses.
- `aggregation.ts` — binding/freshness validation and deterministic summaries.
- `projection-store.ts` — typed ordered ingestion, replay protection,
  last-verified reads, pagination, and content-minimal operator audit.
- `http.ts` — tenant-derived read handlers and separately authorized operator
  handlers.
- `runtime.ts` — deny-by-default production ports.
- `fixtures.ts` — synthetic, content-free Phase-0 projections only.

The route runtime deliberately denies both tenant capabilities and operator
portfolio policy until the existing identity boundary is connected to an
approved policy adapter. Tests inject narrow policies. A role string, header,
query value, environment value, or browser storage entry never grants access.

The server-rendered pages use the labelled synthetic fixture so the Phase-0 UI
can be built, reviewed, and tested without a database, cluster, registry, model,
external telemetry source, tenant data, or public network. The preview is not a
production authorization or runtime claim. Production data is available only
through the authenticated API handlers and a future approved adapter.

## Routes

Tenant routes derive organization identity from the opaque server session:

```text
GET /api/v1alpha1/overview
GET /api/v1alpha1/planes/{planeId}
GET /api/v1alpha1/harnesses/{harnessId}
```

Operator routes require a separate `organization:portfolio:view` decision. An
allow or deny is appended before a response; an audit failure refuses access.

```text
GET /api/v1alpha1/organizations?cursor=&limit=&state=
GET /api/v1alpha1/organizations/{organizationId}/overview
```

Unknown and unauthorized organization-scoped objects use the same bounded 404
response. The portfolio list uses a closed state filter, limit 1 through 200,
stable sort, and an opaque digest cursor.

Browser destinations are `/overview`, `/planes/[planeId]`,
`/harnesses/[harnessId]`, `/organizations`, and
`/organizations/[organizationId]`. The onion is progressive enhancement: native
plane/harness links and the adjacent semantic list are authoritative navigation.
At compact widths the onion disappears and the complete list remains.

## Projection ingestion

`ProjectionStore.ingest` accepts only one of eight typed sources. Every summary
binds its organization, source, event, monotonic sequence and cursor, timestamp,
source-principal and source-admission digests, profile/bundle/release digests,
generation, full content digest, overview, four planes, and sixteen harnesses.
An injected source-admission policy denies by default; validation happens before
mutation.

- Identical event replay returns `REPLAYED` without a write.
- Changed duplicate, gap, regression, future observation, invalid taxonomy,
  invalid axis, or binding drift fails atomically.
- Source loss preserves the last verified facts and changes freshness to
  `SOURCE_UNAVAILABLE`; selected health is blocked rather than fabricated.
- No ingestion event can assert a status not present in its validated snapshot.

## Database boundary

`packages/db/migrations/harness-status/001_status_projection.sql` is additive.
Every tenant projection/cursor/finding table includes `organization_id`, enables
and forces RLS, and uses `control.current_organization_id()`. Grants are limited
to select, insert, and named update columns. Delete, truncate, DDL, wildcard,
superuser, and BYPASSRLS authority are absent.

The operator function is `SECURITY DEFINER` with an empty search path, fixed SQL,
closed pagination, and same-transaction audit. It is revoked from public and all
existing runtime roles; this packet intentionally grants no caller execute
authority. A later reviewed deployment adapter must supply a separate database
identity and a policy decision without weakening RLS.

Static SQL review and the independent in-memory isolation model are source
evidence only. A live credential-free PostgreSQL endpoint is not available in
the signed socket-free runner, so live database evidence is
`NOT_RUN_ENV_UNAVAILABLE`.

## Accessibility and offline operation

The overview provides one main landmark, ordered headings, breadcrumbs, visible
focus, textual state labels, minimum 44-pixel controls, a semantic list
equivalent, and a one-tab-stop onion with clockwise arrow navigation. It covers
320 CSS-pixel reflow, 200-percent zoom, reduced motion, forced colors, loading,
empty, error, stale, source-unavailable, and indistinguishable not-found states.

All fonts, CSS, icons, scripts, and fixtures are local. Playwright launches the
root-owned Chromium Headless Shell 149.0.7827.55 by pipe and refuses every
browser request not using `data:` or `about:`. This proves deterministic browser
semantics without claiming socket-level browser/backend integration. Manual
screen-reader, contrast, comprehension, and production reverse-proxy review are
`NOT_RUN_ENV_UNAVAILABLE` until performed by people in the target environment.

## Offline acceptance

The hash-pinned launcher runs in this order:

```text
make prefetch
make bootstrap-e2e
make status-contract
make overview-e2e
make overview-accessibility
make zero-public-browser-requests
make zero-bill
```

All commands are direct argv inside one OS-enforced deny-all-outbound process
tree. No hosted runner, Actions artifact/cache/package, runtime download, API
key, cloud credential, billable broker, or public service participates.

## Rollback

Disable the additive routes, restore the exact CTRL-006-compatible web image,
and revert CTRL-007 source and descriptor together. Retain every projection,
source cursor, finding, and operator audit row for its policy retention period.
Never use rollback to delete evidence, weaken RLS, broaden operator authority,
coerce status, or imply runtime or tenant acceptance.
