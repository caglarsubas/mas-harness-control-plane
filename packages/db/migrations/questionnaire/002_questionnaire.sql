BEGIN;

SET LOCAL ROLE control_owner;

CREATE TABLE control.questionnaire_session (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  session_id uuid NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z0-9][a-z0-9.-]{1,127}$'),
  pack_version text NOT NULL CHECK (pack_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  pack_digest text NOT NULL CHECK (pack_digest ~ '^sha256:[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('DRAFT', 'IN_PROGRESS', 'BLOCKED', 'READY_FOR_COMPILATION', 'SUPERSEDED')),
  current_stage_id text NOT NULL CHECK (current_stage_id IN (
    'business-context', 'domain-and-outcomes', 'data-readiness', 'governance-and-regulation',
    'integration-readiness', 'harness-demand', 'environment-and-provider-fit', 'evidence-and-acceptance'
  )),
  completed_stage_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(completed_stage_ids) <= 8),
  current_revision bigint NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK (updated_at >= created_at),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, session_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

CREATE TABLE control.answer_revision (
  organization_id uuid NOT NULL,
  session_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 1),
  stage_id text NOT NULL CHECK (stage_id IN (
    'business-context', 'domain-and-outcomes', 'data-readiness', 'governance-and-regulation',
    'integration-readiness', 'harness-demand', 'environment-and-provider-fit', 'evidence-and-acceptance'
  )),
  answer_set jsonb NOT NULL CHECK (jsonb_typeof(answer_set) = 'array'),
  actor_digest text NOT NULL CHECK (actor_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, session_id, revision),
  FOREIGN KEY (organization_id, session_id) REFERENCES control.questionnaire_session (organization_id, session_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

CREATE TABLE control.readiness_finding (
  organization_id uuid NOT NULL,
  session_id uuid NOT NULL,
  finding_id text NOT NULL CHECK (finding_id ~ '^sha256:[0-9a-f]{64}$'),
  review_revision bigint NOT NULL CHECK (review_revision > 1),
  stage_id text NOT NULL CHECK (stage_id IN (
    'business-context', 'domain-and-outcomes', 'data-readiness', 'governance-and-regulation',
    'integration-readiness', 'harness-demand', 'environment-and-provider-fit', 'evidence-and-acceptance'
  )),
  question_id text,
  severity text NOT NULL CHECK (severity IN ('BLOCKING', 'PASS')),
  reason_code text NOT NULL CHECK (reason_code IN ('MISSING_REQUIRED_ANSWER', 'QUESTIONNAIRE_COMPLETE')),
  occurred_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  audit_event_id uuid NOT NULL,
  PRIMARY KEY (organization_id, session_id, finding_id),
  FOREIGN KEY (organization_id, session_id) REFERENCES control.questionnaire_session (organization_id, session_id),
  FOREIGN KEY (organization_id, audit_event_id) REFERENCES control.audit_event (organization_id, event_id)
);

ALTER TABLE control.questionnaire_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.questionnaire_session FORCE ROW LEVEL SECURITY;
CREATE POLICY questionnaire_session_isolation ON control.questionnaire_session
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.answer_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.answer_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY answer_revision_isolation ON control.answer_revision
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.readiness_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.readiness_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY readiness_finding_isolation ON control.readiness_finding
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE TRIGGER answer_revision_append_only
BEFORE UPDATE OR DELETE ON control.answer_revision
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER readiness_finding_append_only
BEFORE UPDATE OR DELETE ON control.readiness_finding
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

RESET ROLE;

GRANT SELECT, INSERT ON control.questionnaire_session TO control_runtime;
GRANT UPDATE (state, current_stage_id, completed_stage_ids, current_revision, updated_at, version, audit_event_id)
  ON control.questionnaire_session TO control_runtime;
GRANT SELECT, INSERT ON control.answer_revision TO control_runtime;
GRANT SELECT, INSERT ON control.readiness_finding TO control_runtime;

REVOKE DELETE, TRUNCATE ON control.questionnaire_session, control.answer_revision, control.readiness_finding FROM control_runtime;

COMMIT;
