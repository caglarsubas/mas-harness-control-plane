# Tenant harness overview

Current corrective source: **Alpha 1 / CTRL-FIX-003** (carried into the Alpha 2
roadmap). It corrects the read model; production identity/storage integration
and native Linux certification remain separate waiting packets. The original
CTRL-007 implementation and acceptance description below are historical scope.

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

## CTRL-FIX-003 — request-time status consistency

The correction consumes unchanged CON-005 semantics and the independently
authored CON-FIX-001 status vectors from merged contracts commit
`fb365aabfd8c5560e064be5d97ff9f2bcc69c57c`. Only data/documentation snapshots
are retained under `contracts/status-regression/`; no predecessor implementation
or warm-source code is copied. Its source lock binds the exact commit, PR/CI,
release manifest, vector, documentation and generated semantics. Tests pin the
original raw bytes and require the manifest's INDEPENDENT_CONTRACT_VECTOR role.
The earlier bootstrap and CON-005 locks remain unchanged.

Each HTTP handler captures `runtime.nowEpoch()` once and supplies that instant
to session authentication, status materialization and operator audit. Direct
store reads accept the same epoch-seconds argument; their default captures
the system clock once per call. Tests use injected request clocks or fake Date
clocks. Nonfinite and pre-projection evaluation times are refused, never treated
as current.

- Every read recomputes freshness using the original admitted binding. The
  exact `freshUntil` boundary is STALE without another ingestion event.
- Known source outages take priority over expiry. Each source recovers only
  through its own successfully admitted next summary; replay is not recovery.
  Recovery never extends old binding windows, restores evidence to PASS, or
  clears other sources' outages.
- Overview, plane and harness projections recompute aggregate states and
  counts together. Portfolio rows use that same materialization before state
  filtering, sorting and pagination. Each request has one instant; pagination
  across different requests does not freeze time. A cursor no longer belonging
  to the filtered result set is refused, and the client must restart that query.
- Each entity retains its admitted binding, evidence, findings and source
  facts. Ingestion takes a deeply frozen value copy rather than caller aliases.
  Read-time outage overlays and derived states never update stored records,
  source cursors, generations or release digests.
- Required COLLECTING is BLOCKED. Any optional non-pass evidence is DEGRADED
  unless a higher-priority rule applies. Non-ready installations and blocked
  selections cannot be hidden by a warning/waiver. REVOKED and required FAIL
  retain precedence; unselected/proposed harnesses stay neutral.
- Tenant context, separate operator policy, audit-before-response, deny-default
  runtime adapters and all public schemas remain unchanged. No production
  database adapter, background timer, network read or browser fan-out is added.

### Independent regression and acceptance evidence

The first exact-source run at `9a157d40b275741d67ed1e759ab3e1e358278e59`
returned 631 passed / 65 failed. Four store failures were later identified as
an invalid test fixture shape, not valid evidence of product defects. That log
is retained at SHA-256
`83290386df331344582a432fca6dbd786eac7f3196fec8f5d5b66d2c4ebf84a3`.
The first corrected implementation run retained those four fixture failures;
it is not acceptance evidence.

After correcting the fixture, an exact committed baseline at
`b79c05af2850a6bf466f6312b7c54fdfc0a9edf3` restored every production status
module byte-for-byte to CTRL-FIX-002 main
`97e461aa22e34002c7407555750a93b69f1b750c`. Typecheck and build passed;
the complete suite returned **631 passed / 67 failed**, with no skips.
It independently reproduced expiration, outage/detail/list inconsistency,
mutable admitted aliases, repeated request-clock reads, optional-axis drift,
and warning/collecting precedence. Log SHA-256:
`80eeb500949878563b77edf0853f18137d99d7d5ab376d97334bde2c3326210e`.

Restored correction `3e3f80ef723e0c978ef6f335d739c2c9cc1d53bf` passed
typecheck, production build, **698 unit tests**, **six predecessor browser
tests**, and zero-bill acceptance. No tests were skipped or deselected, and
every predecessor Vitest file ran. Log SHA-256:
`320270111225c455c6d19d5c8a5e3463984f9b4b390034f84596b03f9dcc8087`.
This is exact local source evidence, not a claim for a later head, PR merge,
GitHub CI or native Linux deployment. Updated exact-head, required CI, merge
and separate local exact-main results must be attached to this packet's PR.

The exact packet session is `make prefetch`, `make ctrl-fix-003-regression`,
`make overview-e2e`, then `make zero-bill`, all inside the installed signed
launcher's one deny-all-outbound process tree. The additive descriptor owns
only ctrl-fix-003-regression and runs typecheck/build/the entire tests directory.
Existing Makefile, dispatcher, handlers, workflows and PORTING remain intact.

| Phase | ID | Status at this source checkpoint | Description |
|---|---|---|---|
| Alpha 2 authority | MET-LINUX-001 | DONE — predecessor source/CI/merge | Linux-first roadmap, meta PR94 |
| Alpha 1 corrective | CTRL-FIX-003 | LOCAL PASS; publication pending | This read-time status correction |
| Alpha 2 foundation | MET-LINUX-002 | WAITING — next roadmap packet | Linux runner candidate and operator kit |
| Alpha 2 early certification | CONF-LINUX-001 | WAITING — independent native execution | Linux AMD64 acceptance; ARM64 separately qualified |
| Alpha 1 integration | CTRL-INTEGRATE-001 | WAITING — fresh Linux gate | Authenticated production pages and durable storage |
| Alpha 2 contracts/runtime | CON-MODEL-001 / MODEL-001 | WAITING — respective predecessors | Contract work versus separately Linux-gated runtime work |

These tests are source/fixture-browser evidence only. They do not certify a live
API/database journey, native Linux runtime, artifact/SBOM, deployment, assurance
or tenant acceptance. Alpha 1 and Alpha 2 remain open. Roll back this correction
as a reviewed source unit before consumption; preserve all admitted data and
regression provenance, or supersede it after downstream consumers pin it.
