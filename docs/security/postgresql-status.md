# CTRL-006 PostgreSQL execution status

Status: `NOT_RUN_ENV_UNAVAILABLE`

No disposable, credential-free local PostgreSQL cluster was supplied to this
packet. Acceptance therefore runs the cumulative migration parser, transaction-
local statement test, and independent in-memory tenant-denial matrix only. It
does not claim that PostgreSQL executed, that a migration was deployed, or that
runtime tenant isolation was observed in a cluster.
