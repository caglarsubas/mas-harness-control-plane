BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_owner') THEN
    CREATE ROLE control_owner NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_migrator') THEN
    CREATE ROLE control_migrator NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_runtime') THEN
    CREATE ROLE control_runtime NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_audit_writer') THEN
    CREATE ROLE control_audit_writer NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS control AUTHORIZATION control_owner;
REVOKE ALL ON SCHEMA public FROM control_owner, control_migrator, control_runtime, control_audit_writer;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA control TO control_migrator, control_runtime, control_audit_writer;

SET LOCAL ROLE control_owner;

CREATE TABLE control.tenant (
  organization_id uuid PRIMARY KEY,
  tenant_digest text NOT NULL CHECK (tenant_digest ~ '^sha256:[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL,
  audit_event_id uuid NOT NULL
);

CREATE TABLE control.authorization_attempt (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  attempt_id uuid NOT NULL,
  state_digest text NOT NULL CHECK (state_digest ~ '^sha256:[0-9a-f]{64}$'),
  nonce_digest text NOT NULL CHECK (nonce_digest ~ '^sha256:[0-9a-f]{64}$'),
  pkce_verifier_digest text NOT NULL CHECK (pkce_verifier_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, attempt_id)
);

CREATE TABLE control.auth_session (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  session_id uuid NOT NULL,
  subject_digest text NOT NULL CHECK (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  admission_digest text NOT NULL CHECK (admission_digest ~ '^sha256:[0-9a-f]{64}$'),
  cookie_digest text NOT NULL CHECK (cookie_digest ~ '^sha256:[0-9a-f]{64}$'),
  csrf_digest text NOT NULL CHECK (csrf_digest ~ '^sha256:[0-9a-f]{64}$'),
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  issued_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL CHECK (absolute_expires_at > issued_at),
  idle_expires_at timestamptz NOT NULL CHECK (idle_expires_at > issued_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, session_id),
  UNIQUE (organization_id, cookie_digest)
);

CREATE TABLE control.auth_session_revision (
  organization_id uuid NOT NULL,
  session_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  occurred_at timestamptz NOT NULL,
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, session_id, revision),
  FOREIGN KEY (organization_id, session_id)
    REFERENCES control.auth_session (organization_id, session_id)
);

CREATE TABLE control.audit_event (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9.-]{2,127}$'),
  aggregate_id uuid NOT NULL,
  aggregate_digest text NOT NULL CHECK (aggregate_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_digest text NOT NULL CHECK (actor_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_link_digest text NOT NULL CHECK (audit_link_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE control.idempotency_record (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  idempotency_digest text NOT NULL CHECK (idempotency_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  response_digest text NOT NULL CHECK (response_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, idempotency_digest)
);

CREATE TABLE control.event_inbox (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9.-]{2,127}$'),
  aggregate_id uuid NOT NULL,
  event_digest text NOT NULL CHECK (event_digest ~ '^sha256:[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE control.event_outbox (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9.-]{2,127}$'),
  aggregate_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  published_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, event_id)
);

CREATE FUNCTION control.current_organization_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
RETURN NULLIF(current_setting('planeon.organization_id', true), '')::uuid;

ALTER TABLE control.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON control.tenant
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.authorization_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.authorization_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY authorization_attempt_isolation ON control.authorization_attempt
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.auth_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.auth_session FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_session_isolation ON control.auth_session
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.auth_session_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.auth_session_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_session_revision_isolation ON control.auth_session_revision
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_event_isolation ON control.audit_event
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_record_isolation ON control.idempotency_record
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox_isolation ON control.event_inbox
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_outbox_isolation ON control.event_outbox
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE FUNCTION control.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_RECORD';
END;
$$;

CREATE TRIGGER auth_session_revision_append_only
BEFORE UPDATE OR DELETE ON control.auth_session_revision
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE ON control.audit_event
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER event_inbox_append_only
BEFORE UPDATE OR DELETE ON control.event_inbox
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER event_outbox_append_only
BEFORE UPDATE OR DELETE ON control.event_outbox
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

RESET ROLE;

GRANT control_owner TO control_migrator;
REVOKE ALL ON FUNCTION control.current_organization_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.current_organization_id() TO control_migrator, control_runtime, control_audit_writer;
GRANT SELECT, INSERT ON control.tenant TO control_runtime;
GRANT SELECT, INSERT ON control.authorization_attempt TO control_runtime;
GRANT UPDATE (consumed_at, version) ON control.authorization_attempt TO control_runtime;
GRANT SELECT, INSERT ON control.auth_session TO control_runtime;
GRANT UPDATE (current_revision, idle_expires_at, version, audit_event_id) ON control.auth_session TO control_runtime;
GRANT SELECT, INSERT ON control.auth_session_revision TO control_runtime;
GRANT SELECT, INSERT ON control.idempotency_record TO control_runtime;
GRANT SELECT, INSERT ON control.event_inbox TO control_runtime;
GRANT SELECT, INSERT ON control.event_outbox TO control_runtime;
GRANT SELECT ON control.audit_event TO control_runtime;
GRANT INSERT ON control.audit_event TO control_audit_writer;

REVOKE CREATE ON SCHEMA control FROM control_runtime, control_audit_writer;
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA control FROM control_audit_writer;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA control FROM control_runtime;

COMMIT;
