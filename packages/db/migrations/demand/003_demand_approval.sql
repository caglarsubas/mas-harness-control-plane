BEGIN;

SET LOCAL ROLE control_owner;

CREATE TABLE control.demand (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  demand_id uuid NOT NULL,
  questionnaire_session_id uuid NOT NULL,
  questionnaire_session_revision bigint NOT NULL CHECK (questionnaire_session_revision > 0),
  questionnaire_answer_set_id text NOT NULL CHECK (questionnaire_answer_set_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'),
  questionnaire_answer_set_digest text NOT NULL CHECK (questionnaire_answer_set_digest ~ '^sha256:[0-9a-f]{64}$'),
  readiness_assessment_id text NOT NULL CHECK (readiness_assessment_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'),
  readiness_assessment_digest text NOT NULL CHECK (readiness_assessment_digest ~ '^sha256:[0-9a-f]{64}$'),
  tenant_demand jsonb NOT NULL CHECK (jsonb_typeof(tenant_demand) = 'object'),
  tenant_demand_digest text NOT NULL CHECK (tenant_demand_digest ~ '^sha256:[0-9a-f]{64}$'),
  proposed_prerequisite_harness_ids text[] NOT NULL CHECK (cardinality(proposed_prerequisite_harness_ids) <= 64),
  current_findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(current_findings) = 'array'),
  state text NOT NULL CHECK (state IN ('DRAFT', 'BLOCKED', 'VALIDATED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  validated_resource_digest text CHECK (validated_resource_digest IS NULL OR validated_resource_digest ~ '^sha256:[0-9a-f]{64}$'),
  validated_revision bigint CHECK (validated_revision IS NULL OR validated_revision > 0),
  approval_id uuid,
  creator_digest text NOT NULL CHECK (creator_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, demand_id),
  FOREIGN KEY (organization_id, questionnaire_session_id)
    REFERENCES control.questionnaire_session (organization_id, session_id),
  FOREIGN KEY (organization_id, audit_event_id)
    REFERENCES control.audit_event (organization_id, event_id),
  CHECK ((validated_resource_digest IS NULL) = (validated_revision IS NULL)),
  CHECK (state NOT IN ('VALIDATED', 'APPROVAL_PENDING', 'APPROVED', 'REJECTED') OR validated_resource_digest IS NOT NULL),
  CHECK ((state IN ('APPROVAL_PENDING', 'APPROVED', 'REJECTED')) = (approval_id IS NOT NULL))
);

CREATE TABLE control.prerequisite_decision (
  organization_id uuid NOT NULL,
  demand_id uuid NOT NULL,
  harness_id text NOT NULL CHECK (harness_id ~ '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$'),
  decision text NOT NULL CHECK (decision IN ('ACCEPT', 'REJECT')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  decision_revision bigint NOT NULL CHECK (decision_revision > 0),
  actor_digest text NOT NULL CHECK (actor_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, demand_id, harness_id),
  FOREIGN KEY (organization_id, demand_id) REFERENCES control.demand (organization_id, demand_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

CREATE TABLE control.approval (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  approval_id uuid NOT NULL,
  demand_id uuid NOT NULL,
  demand_revision bigint NOT NULL CHECK (demand_revision > 0),
  demand_digest text NOT NULL CHECK (demand_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy_ref jsonb NOT NULL CHECK (jsonb_typeof(policy_ref) = 'object'),
  policy_binding_digest text NOT NULL CHECK (policy_binding_digest ~ '^sha256:[0-9a-f]{64}$'),
  requester_digest text NOT NULL CHECK (requester_digest ~ '^sha256:[0-9a-f]{64}$'),
  eligible_reviewer_digests text[] NOT NULL CHECK (
    cardinality(eligible_reviewer_digests) BETWEEN 1 AND 32 AND
    NOT requester_digest = ANY (eligible_reviewer_digests)
  ),
  required_decisions integer NOT NULL CHECK (required_decisions BETWEEN 1 AND 32),
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(decisions) = 'array'),
  state text NOT NULL CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > requested_at),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, approval_id),
  UNIQUE (organization_id, demand_id),
  FOREIGN KEY (organization_id, demand_id) REFERENCES control.demand (organization_id, demand_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id),
  CHECK (required_decisions <= cardinality(eligible_reviewer_digests)),
  CHECK ((state = 'PENDING') = (reason_code IS NULL))
);

ALTER TABLE control.demand
  ADD CONSTRAINT demand_approval_reference
  FOREIGN KEY (organization_id, approval_id)
  REFERENCES control.approval (organization_id, approval_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE control.demand ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.demand FORCE ROW LEVEL SECURITY;
CREATE POLICY demand_isolation ON control.demand
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.prerequisite_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.prerequisite_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY prerequisite_decision_isolation ON control.prerequisite_decision
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.approval FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_isolation ON control.approval
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE FUNCTION control.guard_demand_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.demand_id <> OLD.demand_id OR
     NEW.questionnaire_session_id <> OLD.questionnaire_session_id OR
     NEW.questionnaire_session_revision <> OLD.questionnaire_session_revision OR
     NEW.questionnaire_answer_set_id <> OLD.questionnaire_answer_set_id OR
     NEW.questionnaire_answer_set_digest <> OLD.questionnaire_answer_set_digest OR
     NEW.readiness_assessment_id <> OLD.readiness_assessment_id OR
     NEW.readiness_assessment_digest <> OLD.readiness_assessment_digest OR
     NEW.tenant_demand <> OLD.tenant_demand OR NEW.tenant_demand_digest <> OLD.tenant_demand_digest OR
     NEW.proposed_prerequisite_harness_ids <> OLD.proposed_prerequisite_harness_ids OR
     NEW.creator_digest <> OLD.creator_digest OR NEW.created_at <> OLD.created_at OR
     NEW.current_revision <> OLD.current_revision + 1 OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'DEMAND_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF OLD.state IN ('APPROVED', 'REJECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'DEMAND_TERMINAL';
  END IF;
  IF NOT (
    (OLD.state = 'DRAFT' AND NEW.state IN ('BLOCKED', 'VALIDATED')) OR
    (OLD.state = 'BLOCKED' AND NEW.state IN ('BLOCKED', 'VALIDATED', 'SUPERSEDED')) OR
    (OLD.state = 'VALIDATED' AND NEW.state IN ('APPROVAL_PENDING', 'SUPERSEDED')) OR
    (OLD.state = 'APPROVAL_PENDING' AND NEW.state IN ('APPROVED', 'REJECTED', 'BLOCKED', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'DEMAND_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION control.guard_approval_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_count integer := jsonb_array_length(OLD.decisions);
  new_count integer := jsonb_array_length(NEW.decisions);
  retained_prefix jsonb;
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.approval_id <> OLD.approval_id OR
     NEW.demand_id <> OLD.demand_id OR NEW.demand_revision <> OLD.demand_revision OR
     NEW.demand_digest <> OLD.demand_digest OR NEW.policy_ref <> OLD.policy_ref OR
     NEW.policy_binding_digest <> OLD.policy_binding_digest OR NEW.requester_digest <> OLD.requester_digest OR
     NEW.eligible_reviewer_digests <> OLD.eligible_reviewer_digests OR
     NEW.required_decisions <> OLD.required_decisions OR NEW.requested_at <> OLD.requested_at OR
     NEW.expires_at <> OLD.expires_at OR NEW.created_at <> OLD.created_at OR
     NEW.current_revision <> OLD.current_revision + 1 OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'APPROVAL_IMMUTABLE_FIELD_OR_REVISION';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'APPROVAL_TERMINAL';
  END IF;
  IF NEW.state NOT IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'APPROVAL_TRANSITION_REFUSED';
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]'::jsonb)
    INTO retained_prefix
    FROM jsonb_array_elements(NEW.decisions) WITH ORDINALITY AS entries(value, ordinal)
    WHERE ordinal <= old_count;
  IF retained_prefix <> OLD.decisions THEN
    RAISE EXCEPTION 'APPROVAL_DECISION_PREFIX_MUTATED';
  END IF;
  IF NEW.state IN ('PENDING', 'APPROVED', 'REJECTED') AND new_count <> old_count + 1 THEN
    RAISE EXCEPTION 'APPROVAL_DECISION_APPEND_REQUIRED';
  END IF;
  IF NEW.state IN ('EXPIRED', 'CANCELLED') AND new_count <> old_count THEN
    RAISE EXCEPTION 'APPROVAL_TERMINAL_DECISION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER demand_legal_transition
BEFORE UPDATE ON control.demand
FOR EACH ROW EXECUTE FUNCTION control.guard_demand_transition();

CREATE TRIGGER demand_no_delete
BEFORE DELETE ON control.demand
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER prerequisite_decision_append_only
BEFORE UPDATE OR DELETE ON control.prerequisite_decision
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER approval_legal_transition
BEFORE UPDATE ON control.approval
FOR EACH ROW EXECUTE FUNCTION control.guard_approval_transition();

CREATE TRIGGER approval_no_delete
BEFORE DELETE ON control.approval
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

RESET ROLE;

GRANT SELECT, INSERT ON control.demand TO control_runtime;
GRANT UPDATE (current_findings, state, current_revision, validated_resource_digest, validated_revision, approval_id, updated_at, version, audit_event_id)
  ON control.demand TO control_runtime;
GRANT SELECT, INSERT ON control.prerequisite_decision TO control_runtime;
GRANT SELECT, INSERT ON control.approval TO control_runtime;
GRANT UPDATE (decisions, state, reason_code, current_revision, updated_at, version, audit_event_id)
  ON control.approval TO control_runtime;

REVOKE DELETE, TRUNCATE ON control.demand, control.prerequisite_decision, control.approval FROM control_runtime;

COMMIT;
