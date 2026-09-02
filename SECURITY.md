# Security policy

Report vulnerabilities privately to the project maintainers. Do not open a public issue containing credentials, tokens, tenant data, or exploit details.

The default product is offline-first and fail-closed. Identity is derived from an operator-supplied local OIDC issuer registry; caller-provided tenant identity is rejected. No secret, private key, token, raw claim, or business payload belongs in source, logs, telemetry, or evidence.
