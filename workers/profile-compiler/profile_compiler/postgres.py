"""Psycopg transaction adapter source; live PostgreSQL evidence is separate."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Callable, Mapping

import psycopg

CLAIM_SQL = """
WITH candidate AS (
  SELECT organization_id, job_id
  FROM control.compilation_job
  WHERE organization_id = %s
    AND ((state IN ('QUEUED', 'RETRY_WAIT') AND available_at <= %s)
      OR (state = 'LEASED' AND lease_expires_at <= %s))
  ORDER BY available_at, created_at, job_id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE control.compilation_job AS job
SET state = 'LEASED', attempt = job.attempt + 1, lease_owner = %s,
    lease_token = %s, claimed_at = %s, lease_expires_at = %s,
    failure_reason = NULL, version = job.version + 1
FROM candidate
WHERE job.organization_id = candidate.organization_id AND job.job_id = candidate.job_id
RETURNING job.*
"""

FENCED_JOB_SQL = """
SELECT * FROM control.compilation_job
WHERE organization_id = %s AND job_id = %s AND state = 'LEASED'
  AND lease_owner = %s AND lease_token = %s AND lease_expires_at > %s
FOR UPDATE
"""


class PostgresCompilationStore:
    """Tenant-partitioned claim primitive using server-bound parameters only."""

    def __init__(self, connect: Callable[[], psycopg.Connection[Any]]) -> None:
        self._connect = connect

    @staticmethod
    def _utc(epoch: int) -> datetime:
        return datetime.fromtimestamp(epoch, UTC)

    def claim(
        self,
        organization_id: str,
        worker_id: str,
        lease_token: str,
        now: int,
        lease_seconds: int = 60,
    ) -> Mapping[str, Any] | None:
        observed = self._utc(now)
        expires = self._utc(now + lease_seconds)
        with self._connect() as connection:
            with connection.transaction():
                connection.execute(
                    "SELECT set_config('planeon.organization_id', %s, true)",
                    (organization_id,),
                )
                row = connection.execute(
                    CLAIM_SQL,
                    (organization_id, observed, observed, worker_id, lease_token, observed, expires),
                ).fetchone()
                return dict(row) if row is not None else None

    def lock_fenced_job(
        self,
        connection: psycopg.Connection[Any],
        organization_id: str,
        job_id: str,
        worker_id: str,
        lease_token: str,
        now: int,
    ) -> Mapping[str, Any] | None:
        connection.execute(
            "SELECT set_config('planeon.organization_id', %s, true)",
            (organization_id,),
        )
        connection.execute(
            "SELECT set_config('planeon.worker_id', %s, true)",
            (worker_id,),
        )
        connection.execute(
            "SELECT set_config('planeon.lease_token', %s, true)",
            (lease_token,),
        )
        row = connection.execute(
            FENCED_JOB_SQL,
            (organization_id, job_id, worker_id, lease_token, self._utc(now)),
        ).fetchone()
        return dict(row) if row is not None else None
