# CTRL-001 execution rules

- Execute exactly one hash-pinned task packet per branch and pull request.
- Touch only packet `allowedPaths`; never mount, inspect, copy, or receive a warm-start checkout.
- Run packet prefetch and acceptance only through the signed external offline launcher.
- Never add hosted runners, paid APIs, provider keys, runtime downloads, remote telemetry, cloud provisioning, or mutable artifact references.
- Preserve source, CI, merge, artifact, deployment, runtime, assurance, and tenant acceptance as separate evidence states.
- Later packets must not edit `Makefile`, the dispatcher, transport, workflow,
  `CTRL-001` handlers, or `PORTING.yaml`. The sole completed exception is
  `CTRL-FIX-001`, which may update only this file, `ci/handlers/prefetch.py`, its
  exact descriptor, and the bootstrap static regression test to admit descendant
  packet history and separately pinned additive dependencies without weakening
  any CTRL-001 pin.
