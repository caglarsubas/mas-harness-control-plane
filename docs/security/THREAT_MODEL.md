# CTRL-006 control-plane threat model

This review closes the Alpha 1 surface implemented by `CTRL-001` through
`CTRL-005`. It does not add product authority.

| Boundary | Adversary action | Required control | Acceptance evidence |
| --- | --- | --- | --- |
| Browser to API | Cross-site mutation or content-type confusion | Existing server session and CSRF proof, same-origin Origin and Fetch Metadata when browser-supplied, JSON-only mutation body | Hostile Origin, cross-site Fetch Metadata, content type, missing CSRF, and bounded error vectors |
| Tenant to control store | Guess another organization's identifiers | Tenant derives only from the admitted server session; indistinguishable not-found results; FORCE RLS | Cross-tenant HTTP/service matrix and cumulative SQL policy parser |
| Caller to concurrency controls | Replay or replace a stale decision | Strong ETag, idempotency key plus fingerprint, terminal-state guards | Missing/stale If-Match, exact replay, divergent replay, duplicate reviewer, and second-lock vectors |
| Operator or compromised record store | Delete, reorder, insert, or change audit facts | Per-organization canonical hash chain with monotonic sequence and duplicate-event refusal | Positive chain verification and changed/reordered/deleted/inserted/predecessor negative vectors |
| Dependency supply chain | Mutable source, unknown license, new install script, or unresolved severe advisory | Exact lock/integrity, npm-registry-only sources, closed license/script dispositions, frozen advisory review | Offline dependency audit and zero-bill scan |
| Browser dependency | Runtime download or public request | Root-owned inventoried open-source Chromium, exact Playwright, pipe transport, `data:`/`about:` only | Signed deny-all-outbound browser run and request listener |

Audit records contain only identifiers and digests. Raw questionnaire answers,
compiled outputs, credentials, tokens, paths, secret values, and exception text
are outside the audit-chain contract. Chain validity is tamper evidence, not a
claim of signer identity, governance approval, deployment, runtime health,
assurance certification, or tenant acceptance.

Live PostgreSQL execution remains `NOT_RUN_ENV_UNAVAILABLE` unless a disposable,
credential-free local database is provided. Static SQL and in-memory tenant
denial tests do not substitute for that state.
