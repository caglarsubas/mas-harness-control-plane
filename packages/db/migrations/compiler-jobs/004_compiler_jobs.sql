BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_compiler_worker') THEN
    CREATE ROLE control_compiler_worker NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_event_publisher') THEN
    CREATE ROLE control_event_publisher NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

GRANT USAGE ON SCHEMA control TO control_compiler_worker, control_event_publisher;

SET LOCAL ROLE control_owner;

CREATE TABLE control.operation (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  operation_pk uuid NOT NULL,
  operation_id text NOT NULL CHECK (operation_id ~ '^operation\.[a-z0-9]+$'),
  operation_type text NOT NULL CHECK (operation_type = 'COMPILE_PROFILE'),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  demand_id uuid NOT NULL,
  demand_revision bigint NOT NULL CHECK (demand_revision > 0),
  demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
  actor_digest text NOT NULL CHECK (actor_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key_digest text NOT NULL CHECK (idempotency_key_digest ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id uuid NOT NULL,
  result_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result_refs) = 'array'),
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  failure_retryable boolean,
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= requested_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, operation_pk),
  UNIQUE (organization_id, operation_id),
  UNIQUE (organization_id, idempotency_key_digest),
  FOREIGN KEY (organization_id, demand_id) REFERENCES control.demand (organization_id, demand_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id),
  CHECK ((state = 'FAILED') = (failure_reason IS NOT NULL)),
  CHECK ((failure_reason IS NULL) = (failure_retryable IS NULL)),
  CHECK (state = 'SUCCEEDED' OR result_refs = '[]'::jsonb)
);

CREATE TABLE control.compilation_job (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  job_pk uuid NOT NULL,
  job_id text NOT NULL CHECK (job_id ~ '^job\.[a-z0-9]+$'),
  operation_pk uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED', 'LEASED', 'RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTERED')),
  demand_id uuid NOT NULL,
  demand_revision bigint NOT NULL CHECK (demand_revision > 0),
  demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  compiler_wheel_digest text NOT NULL CHECK (compiler_wheel_digest ~ '^sha256:[0-9a-f]{64}$'),
  compile_request jsonb NOT NULL CHECK (jsonb_typeof(compile_request) = 'object'),
  catalog_resources jsonb NOT NULL CHECK (jsonb_typeof(catalog_resources) = 'array'),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL,
  lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^worker\.[a-z0-9.-]+$'),
  lease_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  result_key text CHECK (result_key IS NULL OR result_key ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, job_pk),
  UNIQUE (organization_id, job_id),
  UNIQUE (organization_id, operation_pk),
  FOREIGN KEY (organization_id, operation_pk) REFERENCES control.operation (organization_id, operation_pk),
  FOREIGN KEY (organization_id, demand_id) REFERENCES control.demand (organization_id, demand_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id),
  CHECK (
    (state = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND claimed_at IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_expires_at > claimed_at AND attempt BETWEEN 1 AND 3)
    OR
    (state <> 'LEASED' AND lease_owner IS NULL AND lease_token IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((state = 'SUCCEEDED') = (result_key IS NOT NULL)),
  CHECK (state = 'RETRY_WAIT' OR failure_reason IS NULL OR state = 'DEAD_LETTERED')
);

CREATE TABLE control.profile (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  profile_pk uuid NOT NULL,
  profile_id text NOT NULL CHECK (profile_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'),
  state text NOT NULL CHECK (state = 'PROPOSED'),
  demand_id uuid NOT NULL,
  demand_revision bigint NOT NULL CHECK (demand_revision > 0),
  demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
  compiler_wheel_digest text NOT NULL CHECK (compiler_wheel_digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_digest text NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  current_revision bigint NOT NULL CHECK (current_revision > 0),
  current_result_key text NOT NULL CHECK (current_result_key ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, profile_pk),
  UNIQUE (organization_id, profile_id),
  UNIQUE (organization_id, demand_id, demand_revision, demand_digest, compiler_wheel_digest, catalog_digest),
  FOREIGN KEY (organization_id, demand_id) REFERENCES control.demand (organization_id, demand_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

CREATE TABLE control.profile_revision (
  organization_id uuid NOT NULL,
  profile_pk uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  result_key text NOT NULL CHECK (result_key ~ '^sha256:[0-9a-f]{64}$'),
  profile_bytes bytea NOT NULL,
  bom_bytes bytea NOT NULL,
  install_plan_bytes bytea NOT NULL,
  evidence_plan_bytes bytea NOT NULL,
  explanation_bytes bytea NOT NULL,
  profile_sha256_bytes bytea NOT NULL,
  output_digests jsonb NOT NULL CHECK (
    jsonb_typeof(output_digests) = 'object' AND
    jsonb_object_length(output_digests) = 6 AND
    output_digests ?& ARRAY['profile.json', 'bom.json', 'install-plan.json', 'evidence-plan.json', 'explanation.md', 'profile.sha256'] AND
    (output_digests ->> 'profile.json') ~ '^sha256:[0-9a-f]{64}$' AND
    (output_digests ->> 'bom.json') ~ '^sha256:[0-9a-f]{64}$' AND
    (output_digests ->> 'install-plan.json') ~ '^sha256:[0-9a-f]{64}$' AND
    (output_digests ->> 'evidence-plan.json') ~ '^sha256:[0-9a-f]{64}$' AND
    (output_digests ->> 'explanation.md') ~ '^sha256:[0-9a-f]{64}$' AND
    (output_digests ->> 'profile.sha256') ~ '^sha256:[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, profile_pk, revision),
  UNIQUE (organization_id, result_key),
  FOREIGN KEY (organization_id, profile_pk) REFERENCES control.profile (organization_id, profile_pk),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

CREATE INDEX compilation_job_claim_order_idx
  ON control.compilation_job (organization_id, available_at, created_at, job_id)
  WHERE state IN ('QUEUED', 'RETRY_WAIT', 'LEASED');

ALTER TABLE control.event_inbox
  ADD COLUMN source_id text,
  ADD COLUMN partition_key text,
  ADD COLUMN subject_id text,
  ADD COLUMN subject_sequence bigint,
  ADD COLUMN original_envelope jsonb,
  ADD CONSTRAINT event_inbox_compiler_envelope_closed CHECK (
    (source_id IS NULL AND partition_key IS NULL AND subject_id IS NULL AND subject_sequence IS NULL AND original_envelope IS NULL)
    OR
    (source_id ~ '^source\.[a-z0-9.-]+$' AND partition_key ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'
      AND subject_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$' AND subject_sequence > 0
      AND jsonb_typeof(original_envelope) = 'object')
  );

ALTER TABLE control.event_outbox
  ADD COLUMN partition_key text,
  ADD COLUMN subject_id text,
  ADD COLUMN subject_sequence bigint,
  ADD COLUMN payload jsonb,
  ADD CONSTRAINT event_outbox_compiler_payload_closed CHECK (
    (partition_key IS NULL AND subject_id IS NULL AND subject_sequence IS NULL AND payload IS NULL)
    OR
    (partition_key ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'
      AND subject_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$' AND subject_sequence > 0
      AND jsonb_typeof(payload) = 'object')
  );

CREATE INDEX event_outbox_compiler_delivery_idx
  ON control.event_outbox (organization_id, occurred_at, event_id)
  WHERE published_at IS NULL;
CREATE INDEX event_inbox_compiler_sequence_idx
  ON control.event_inbox (organization_id, aggregate_id, version);
CREATE UNIQUE INDEX event_inbox_compiler_subject_sequence_unique
  ON control.event_inbox (organization_id, subject_id, subject_sequence)
  WHERE subject_id IS NOT NULL;
CREATE UNIQUE INDEX event_outbox_compiler_subject_sequence_unique
  ON control.event_outbox (organization_id, subject_id, subject_sequence)
  WHERE subject_id IS NOT NULL;

ALTER TABLE control.operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.operation FORCE ROW LEVEL SECURITY;
CREATE POLICY operation_isolation ON control.operation
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.compilation_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.compilation_job FORCE ROW LEVEL SECURITY;
CREATE POLICY compilation_job_isolation ON control.compilation_job
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.profile FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_isolation ON control.profile
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.profile_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_revision_isolation ON control.profile_revision
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE FUNCTION control.guard_operation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.operation_pk <> OLD.operation_pk OR
     NEW.operation_id <> OLD.operation_id OR NEW.operation_type <> OLD.operation_type OR
     NEW.demand_id <> OLD.demand_id OR NEW.demand_revision <> OLD.demand_revision OR
     NEW.demand_digest <> OLD.demand_digest OR NEW.actor_digest <> OLD.actor_digest OR
     NEW.idempotency_key_digest <> OLD.idempotency_key_digest OR NEW.correlation_id <> OLD.correlation_id OR
     NEW.requested_at <> OLD.requested_at OR NEW.current_revision <> OLD.current_revision + 1 OR
     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'OPERATION_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF NOT (
    (OLD.state = 'PENDING' AND NEW.state IN ('RUNNING', 'CANCELLED')) OR
    (OLD.state = 'RUNNING' AND NEW.state IN ('SUCCEEDED', 'FAILED', 'CANCELLING')) OR
    (OLD.state = 'CANCELLING' AND NEW.state IN ('CANCELLED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'OPERATION_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.guard_compilation_job_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  submitted_token text := NULLIF(current_setting('planeon.lease_token', true), '');
  submitted_worker text := NULLIF(current_setting('planeon.worker_id', true), '');
  expired_reclaim boolean := OLD.state = 'LEASED' AND NEW.state = 'LEASED' AND
    NEW.attempt = OLD.attempt + 1 AND NEW.claimed_at >= OLD.lease_expires_at;
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.job_pk <> OLD.job_pk OR NEW.job_id <> OLD.job_id OR
     NEW.operation_pk <> OLD.operation_pk OR NEW.demand_id <> OLD.demand_id OR
     NEW.demand_revision <> OLD.demand_revision OR NEW.demand_digest <> OLD.demand_digest OR
     NEW.input_digest <> OLD.input_digest OR NEW.catalog_digest <> OLD.catalog_digest OR
     NEW.compiler_wheel_digest <> OLD.compiler_wheel_digest OR NEW.compile_request <> OLD.compile_request OR
     NEW.catalog_resources <> OLD.catalog_resources OR NEW.created_at <> OLD.created_at OR
     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'COMPILATION_JOB_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF OLD.state = 'LEASED' AND NOT expired_reclaim AND
     (submitted_token IS DISTINCT FROM OLD.lease_token::text OR submitted_worker IS DISTINCT FROM OLD.lease_owner) THEN
    RAISE EXCEPTION 'LEASE_FENCE_REFUSED';
  END IF;
  IF NOT (
    (OLD.state IN ('QUEUED', 'RETRY_WAIT') AND NEW.state = 'LEASED' AND NEW.attempt = OLD.attempt + 1) OR
    (OLD.state = 'LEASED' AND NEW.state = 'LEASED' AND NEW.attempt = OLD.attempt AND
      NEW.lease_owner = OLD.lease_owner AND NEW.lease_token = OLD.lease_token AND
      NEW.lease_expires_at > OLD.lease_expires_at) OR
    (OLD.state = 'LEASED' AND NEW.state IN ('RETRY_WAIT', 'SUCCEEDED', 'DEAD_LETTERED') AND NEW.attempt = OLD.attempt) OR
    (OLD.state = 'LEASED' AND NEW.state = 'LEASED' AND NEW.attempt = OLD.attempt + 1 AND
      NEW.claimed_at >= OLD.lease_expires_at)
  ) THEN
    RAISE EXCEPTION 'COMPILATION_JOB_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.guard_profile_pointer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.profile_pk <> OLD.profile_pk OR
     NEW.profile_id <> OLD.profile_id OR NEW.state <> OLD.state OR NEW.demand_id <> OLD.demand_id OR
     NEW.demand_revision <> OLD.demand_revision OR NEW.demand_digest <> OLD.demand_digest OR
     NEW.compiler_wheel_digest <> OLD.compiler_wheel_digest OR NEW.catalog_digest <> OLD.catalog_digest OR
     NEW.created_at <> OLD.created_at OR NEW.current_revision <> OLD.current_revision + 1 OR
     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PROFILE_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operation_legal_transition
BEFORE UPDATE ON control.operation
FOR EACH ROW EXECUTE FUNCTION control.guard_operation_transition();
CREATE TRIGGER operation_no_delete
BEFORE DELETE ON control.operation
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER compilation_job_legal_transition
BEFORE UPDATE ON control.compilation_job
FOR EACH ROW EXECUTE FUNCTION control.guard_compilation_job_transition();
CREATE TRIGGER compilation_job_no_delete
BEFORE DELETE ON control.compilation_job
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER profile_pointer_guard
BEFORE UPDATE ON control.profile
FOR EACH ROW EXECUTE FUNCTION control.guard_profile_pointer();
CREATE TRIGGER profile_no_delete
BEFORE DELETE ON control.profile
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();
CREATE TRIGGER profile_revision_append_only
BEFORE UPDATE OR DELETE ON control.profile_revision
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

RESET ROLE;

REVOKE ALL ON FUNCTION control.guard_operation_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION control.guard_compilation_job_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION control.guard_profile_pointer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.current_organization_id() TO control_compiler_worker, control_event_publisher;

GRANT SELECT, INSERT ON control.operation, control.compilation_job TO control_runtime;
GRANT SELECT ON control.operation, control.compilation_job, control.profile, control.profile_revision TO control_runtime;

GRANT SELECT ON control.demand, control.operation, control.compilation_job, control.profile, control.profile_revision TO control_compiler_worker;
GRANT SELECT, INSERT ON control.event_inbox TO control_compiler_worker;
GRANT UPDATE (state, current_revision, result_refs, failure_reason, failure_retryable, updated_at, version, audit_event_id)
  ON control.operation TO control_compiler_worker;
GRANT UPDATE (state, attempt, available_at, lease_owner, lease_token, claimed_at, lease_expires_at, failure_reason, result_key, updated_at, version, audit_event_id)
  ON control.compilation_job TO control_compiler_worker;
GRANT INSERT ON control.profile, control.profile_revision, control.audit_event, control.event_outbox TO control_compiler_worker;
GRANT UPDATE (current_revision, current_result_key, updated_at, version, audit_event_id)
  ON control.profile TO control_compiler_worker;

GRANT SELECT ON control.event_outbox TO control_event_publisher;
GRANT INSERT ON control.audit_event TO control_event_publisher;

REVOKE CREATE ON SCHEMA control FROM control_runtime, control_compiler_worker, control_event_publisher;
REVOKE DELETE, TRUNCATE ON control.operation, control.compilation_job, control.profile, control.profile_revision
  FROM control_runtime, control_compiler_worker, control_event_publisher;

COMMIT;
