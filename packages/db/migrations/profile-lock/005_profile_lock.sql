BEGIN;

SET LOCAL ROLE control_owner;

ALTER TABLE control.profile DROP CONSTRAINT profile_state_check;
ALTER TABLE control.profile
  ADD CONSTRAINT profile_state_check
  CHECK (state IN ('PROPOSED', 'APPROVAL_PENDING', 'LOCKED', 'REJECTED', 'SUPERSEDED'));

ALTER TABLE control.operation DROP CONSTRAINT operation_operation_type_check;
ALTER TABLE control.operation
  ADD CONSTRAINT operation_operation_type_check
  CHECK (operation_type IN ('COMPILE_PROFILE', 'BUILD_BUNDLE'));

CREATE TABLE control.profile_approval (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  approval_pk uuid NOT NULL,
  approval_id text NOT NULL CHECK (approval_id ~ '^approval\.[a-z0-9]+$'),
  profile_pk uuid NOT NULL,
  profile_revision bigint NOT NULL CHECK (profile_revision > 0),
  result_key text NOT NULL CHECK (result_key ~ '^sha256:[0-9a-f]{64}$'),
  profile_review_digest text NOT NULL CHECK (profile_review_digest ~ '^sha256:[0-9a-f]{64}$'),
  requester_digest text NOT NULL CHECK (requester_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy_ref jsonb NOT NULL CHECK (jsonb_typeof(policy_ref) = 'object'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  required_decisions integer NOT NULL CHECK (required_decisions BETWEEN 1 AND 32),
  eligible_reviewer_digests jsonb NOT NULL CHECK (
    jsonb_typeof(eligible_reviewer_digests) = 'array' AND jsonb_array_length(eligible_reviewer_digests) BETWEEN required_decisions AND 32
  ),
  state text NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(decisions) = 'array'),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$'),
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > requested_at),
  updated_at timestamptz NOT NULL CHECK (updated_at >= requested_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, approval_pk),
  UNIQUE (organization_id, approval_id),
  UNIQUE (organization_id, profile_pk, profile_revision, result_key, profile_review_digest),
  FOREIGN KEY (organization_id, profile_pk, profile_revision)
    REFERENCES control.profile_revision (organization_id, profile_pk, revision),
  FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES control.audit_event (organization_id, event_id),
  CHECK ((state = 'PENDING') = (reason_code IS NULL))
);

CREATE TABLE control.profile_lock (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  lock_pk uuid NOT NULL,
  lock_id text NOT NULL CHECK (lock_id ~ '^lock\.[a-z0-9]+$'),
  profile_pk uuid NOT NULL,
  profile_revision bigint NOT NULL CHECK (profile_revision > 0),
  result_key text NOT NULL CHECK (result_key ~ '^sha256:[0-9a-f]{64}$'),
  profile_review_digest text NOT NULL CHECK (profile_review_digest ~ '^sha256:[0-9a-f]{64}$'),
  approval_pk uuid NOT NULL,
  approval_revision bigint NOT NULL CHECK (approval_revision > 0),
  approval_digest text NOT NULL CHECK (approval_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  lock_digest text NOT NULL CHECK (lock_digest ~ '^sha256:[0-9a-f]{64}$'),
  locked_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version = 1),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, lock_pk),
  UNIQUE (organization_id, lock_id),
  UNIQUE (organization_id, lock_digest),
  UNIQUE (organization_id, profile_pk),
  FOREIGN KEY (organization_id, profile_pk, profile_revision)
    REFERENCES control.profile_revision (organization_id, profile_pk, revision),
  FOREIGN KEY (organization_id, approval_pk)
    REFERENCES control.profile_approval (organization_id, approval_pk),
  FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES control.audit_event (organization_id, event_id)
);

CREATE TABLE control.bundle_request (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  request_pk uuid NOT NULL,
  request_id text NOT NULL CHECK (request_id ~ '^bundle-request\.[a-z0-9]+$'),
  profile_pk uuid NOT NULL,
  lock_pk uuid NOT NULL,
  profile_review_digest text NOT NULL CHECK (profile_review_digest ~ '^sha256:[0-9a-f]{64}$'),
  profile_lock_digest text NOT NULL CHECK (profile_lock_digest ~ '^sha256:[0-9a-f]{64}$'),
  operation_pk uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('REQUESTED', 'SOURCE_REPORTED_SIGNED')),
  source_id text CHECK (source_id IS NULL OR source_id ~ '^source\.[a-z0-9.-]+$'),
  source_partition text CHECK (source_partition IS NULL OR source_partition ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'),
  source_event_id uuid,
  source_sequence bigint CHECK (source_sequence IS NULL OR source_sequence > 0),
  source_observed_at timestamptz,
  bundle_release jsonb CHECK (bundle_release IS NULL OR jsonb_typeof(bundle_release) = 'object'),
  bundle_release_digest text CHECK (bundle_release_digest IS NULL OR bundle_release_digest ~ '^sha256:[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= requested_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, request_pk),
  UNIQUE (organization_id, request_id),
  UNIQUE (organization_id, lock_pk),
  UNIQUE (organization_id, operation_pk),
  UNIQUE (source_id, source_partition, source_sequence),
  UNIQUE (source_event_id),
  FOREIGN KEY (organization_id, profile_pk)
    REFERENCES control.profile (organization_id, profile_pk),
  FOREIGN KEY (organization_id, lock_pk)
    REFERENCES control.profile_lock (organization_id, lock_pk),
  FOREIGN KEY (organization_id, operation_pk)
    REFERENCES control.operation (organization_id, operation_pk),
  FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES control.audit_event (organization_id, event_id),
  CHECK (
    (state = 'REQUESTED' AND source_id IS NULL AND source_partition IS NULL AND source_event_id IS NULL
      AND source_sequence IS NULL AND source_observed_at IS NULL AND bundle_release IS NULL AND bundle_release_digest IS NULL)
    OR
    (state = 'SOURCE_REPORTED_SIGNED' AND source_id IS NOT NULL AND source_partition IS NOT NULL
      AND source_event_id IS NOT NULL AND source_sequence IS NOT NULL AND source_observed_at IS NOT NULL
      AND bundle_release IS NOT NULL AND bundle_release_digest IS NOT NULL)
  )
);

ALTER TABLE control.profile_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.profile_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_approval_isolation ON control.profile_approval
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.profile_lock ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.profile_lock FORCE ROW LEVEL SECURITY;
CREATE POLICY profile_lock_isolation ON control.profile_lock
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.bundle_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.bundle_request FORCE ROW LEVEL SECURITY;
CREATE POLICY bundle_request_isolation ON control.bundle_request
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE OR REPLACE FUNCTION control.guard_operation_transition() RETURNS trigger
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

CREATE OR REPLACE FUNCTION control.guard_profile_pointer() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.profile_pk <> OLD.profile_pk OR
     NEW.profile_id <> OLD.profile_id OR NEW.demand_id <> OLD.demand_id OR
     NEW.demand_revision <> OLD.demand_revision OR NEW.demand_digest <> OLD.demand_digest OR
     NEW.compiler_wheel_digest <> OLD.compiler_wheel_digest OR NEW.catalog_digest <> OLD.catalog_digest OR
     NEW.created_at <> OLD.created_at OR NEW.current_revision <> OLD.current_revision OR
     NEW.current_result_key <> OLD.current_result_key OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PROFILE_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF NOT (
    (OLD.state = 'PROPOSED' AND NEW.state = 'APPROVAL_PENDING') OR
    (OLD.state = 'APPROVAL_PENDING' AND NEW.state IN ('LOCKED', 'REJECTED')) OR
    (OLD.state IN ('PROPOSED', 'REJECTED') AND NEW.state = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'PROFILE_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.guard_profile_approval_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.approval_pk <> OLD.approval_pk OR
     NEW.approval_id <> OLD.approval_id OR NEW.profile_pk <> OLD.profile_pk OR
     NEW.profile_revision <> OLD.profile_revision OR NEW.result_key <> OLD.result_key OR
     NEW.profile_review_digest <> OLD.profile_review_digest OR NEW.requester_digest <> OLD.requester_digest OR
     NEW.policy_ref <> OLD.policy_ref OR NEW.policy_digest <> OLD.policy_digest OR
     NEW.required_decisions <> OLD.required_decisions OR NEW.eligible_reviewer_digests <> OLD.eligible_reviewer_digests OR
     NEW.requested_at <> OLD.requested_at OR NEW.expires_at <> OLD.expires_at OR
     NEW.current_revision <> OLD.current_revision + 1 OR NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'PROFILE_APPROVAL_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF OLD.state <> 'PENDING' OR NEW.state NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED') OR
     jsonb_array_length(NEW.decisions) < jsonb_array_length(OLD.decisions) THEN
    RAISE EXCEPTION 'PROFILE_APPROVAL_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.guard_bundle_request_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.request_pk <> OLD.request_pk OR
     NEW.request_id <> OLD.request_id OR NEW.profile_pk <> OLD.profile_pk OR NEW.lock_pk <> OLD.lock_pk OR
     NEW.profile_review_digest <> OLD.profile_review_digest OR NEW.profile_lock_digest <> OLD.profile_lock_digest OR
     NEW.operation_pk <> OLD.operation_pk OR NEW.requested_at <> OLD.requested_at OR
     NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at OR
     OLD.state <> 'REQUESTED' OR NEW.state <> 'SOURCE_REPORTED_SIGNED' THEN
    RAISE EXCEPTION 'BUNDLE_REQUEST_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profile_approval_legal_transition
BEFORE UPDATE ON control.profile_approval
FOR EACH ROW EXECUTE FUNCTION control.guard_profile_approval_transition();
CREATE TRIGGER profile_approval_no_delete
BEFORE DELETE ON control.profile_approval
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER profile_lock_append_only
BEFORE UPDATE OR DELETE ON control.profile_lock
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER bundle_request_legal_transition
BEFORE UPDATE ON control.bundle_request
FOR EACH ROW EXECUTE FUNCTION control.guard_bundle_request_transition();
CREATE TRIGGER bundle_request_no_delete
BEFORE DELETE ON control.bundle_request
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

RESET ROLE;

REVOKE ALL ON FUNCTION control.guard_profile_approval_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION control.guard_bundle_request_transition() FROM PUBLIC;

GRANT SELECT, INSERT ON control.profile_approval, control.profile_lock, control.bundle_request TO control_runtime;
GRANT UPDATE (state, decisions, reason_code, current_revision, updated_at, version, audit_event_id)
  ON control.profile_approval TO control_runtime;
GRANT UPDATE (state, source_id, source_partition, source_event_id, source_sequence, source_observed_at,
  bundle_release, bundle_release_digest, updated_at, version, audit_event_id)
  ON control.bundle_request TO control_runtime;
GRANT UPDATE (state, current_revision, updated_at, version, audit_event_id)
  ON control.profile TO control_runtime;
GRANT UPDATE (state, current_revision, result_refs, failure_reason, failure_retryable, updated_at, version, audit_event_id)
  ON control.operation TO control_runtime;

REVOKE CREATE ON SCHEMA control FROM control_runtime, control_compiler_worker, control_event_publisher;
REVOKE DELETE, TRUNCATE ON control.profile_approval, control.profile_lock, control.bundle_request
  FROM control_runtime, control_compiler_worker, control_event_publisher;

COMMIT;
