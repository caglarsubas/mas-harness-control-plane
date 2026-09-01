# Planeon MAS Harness Control Plane

The control plane is the offline-first management surface for guided harness setup. `CTRL-001` contains only the authenticated foundation: OIDC admission/session primitives, server-derived tenant context, health/readiness, an inert profile-compiler worker, tenant-isolated PostgreSQL source contracts, and disabled-by-default deployment source.

It does not yet implement questionnaires, demands, approvals, profile compilation, bundles, tenant overviews, plane/harness drill-down, deployment, or runtime execution. Those capabilities are separately packet-owned.

## Processes

- `control-web`: a self-hosted Next.js App Router process exposing `GET /health/live` and `GET /health/ready` only.
- `profile-compiler-worker`: a separate Python process exposing command-line `--health-check` and `--run-once`; the only work result is `IDLE_BOOTSTRAP`.

## Verification

Acceptance is authorized only through the external trusted launcher with the hash-pinned `CTRL-001` packet. Direct local commands are diagnostic and cannot substitute for signed deny-all-outbound evidence.

```text
make prefetch
make bootstrap-e2e
make zero-bill
```

The Helm chart is inert by default. It provisions no identity provider, database, secret, storage, public route, registry, cloud resource, or credentials.
