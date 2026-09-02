BEGIN;

SET LOCAL ROLE control_owner;

CREATE TABLE control.tenant_harness_status_projection (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  harness_id text NOT NULL CHECK (harness_id ~ '^(runtime|knowledge|execution|trust)\.[a-z0-9-]+$'),
  observed_generation bigint NOT NULL CHECK (observed_generation > 0),
  profile_digest text NOT NULL CHECK (profile_digest ~ '^sha256:[0-9a-f]{64}$'),
  bundle_digest text NOT NULL CHECK (bundle_digest ~ '^sha256:[0-9a-f]{64}$'),
  release_digest text NOT NULL CHECK (release_digest ~ '^sha256:[0-9a-f]{64}$'),
  aggregate_state text NOT NULL CHECK (aggregate_state IN ('EMPTY', 'READY', 'DEGRADED', 'BLOCKED', 'FAILED', 'REVOKED')),
  projected_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL CHECK (fresh_until > projected_at),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^sha256:[0-9a-f]{64}$'),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  PRIMARY KEY (organization_id, harness_id)
);

CREATE TABLE control.tenant_plane_status_projection (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  plane_id text NOT NULL CHECK (plane_id IN ('runtime', 'knowledge', 'execution', 'trust')),
  observed_generation bigint NOT NULL CHECK (observed_generation > 0),
  aggregate_state text NOT NULL CHECK (aggregate_state IN ('EMPTY', 'READY', 'DEGRADED', 'BLOCKED', 'FAILED', 'REVOKED')),
  projected_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL CHECK (fresh_until > projected_at),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^sha256:[0-9a-f]{64}$'),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  PRIMARY KEY (organization_id, plane_id)
);

CREATE TABLE control.tenant_overview_projection (
  organization_id uuid PRIMARY KEY REFERENCES control.tenant (organization_id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  deployment_mode text NOT NULL CHECK (deployment_mode IN ('operator-hosted-saas', 'tenant-public-cloud', 'self-managed', 'air-gapped')),
  observed_generation bigint NOT NULL CHECK (observed_generation > 0),
  aggregate_state text NOT NULL CHECK (aggregate_state IN ('EMPTY', 'READY', 'DEGRADED', 'BLOCKED', 'FAILED', 'REVOKED')),
  projected_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL CHECK (fresh_until > projected_at),
  projection_digest text NOT NULL CHECK (projection_digest ~ '^sha256:[0-9a-f]{64}$'),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object')
);

CREATE TABLE control.status_projection_cursor (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  source_id text NOT NULL CHECK (source_id ~ '^source\.[a-z0-9-]+$'),
  source_sequence bigint NOT NULL CHECK (source_sequence > 0),
  source_cursor text NOT NULL CHECK (source_cursor ~ '^[A-Za-z0-9._:-]{1,256}$'),
  source_event_id text NOT NULL CHECK (source_event_id ~ '^event\.[a-z0-9._:-]+$'),
  source_content_digest text NOT NULL CHECK (source_content_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('CURRENT', 'SOURCE_UNAVAILABLE')),
  PRIMARY KEY (organization_id, source_id),
  UNIQUE (source_id, source_event_id)
);

CREATE TABLE control.status_projection_finding (
  organization_id uuid NOT NULL REFERENCES control.tenant (organization_id),
  finding_id text NOT NULL CHECK (finding_id ~ '^finding\.[a-z0-9._:-]+$'),
  observed_generation bigint NOT NULL CHECK (observed_generation > 0),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$'),
  affected_axis text CHECK (affected_axis IS NULL OR affected_axis IN ('SOURCE', 'CONTRACT_UNIT', 'PR_CHECK', 'MERGE', 'ARTIFACT_SBOM', 'SIGNATURE_RELEASE', 'DEPLOYMENT', 'RUNTIME', 'SECURITY', 'ASSURANCE', 'TENANT_ACCEPTANCE')),
  blocking boolean NOT NULL,
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-z0-9][a-z0-9._:-]{1,127}$'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  finding jsonb NOT NULL CHECK (jsonb_typeof(finding) = 'object'),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, finding_id, observed_generation)
);

CREATE TABLE control.status_projection_operator_audit (
  audit_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^operator-audit\.[a-z0-9._:-]+$'),
  subject_digest text NOT NULL CHECK (subject_digest ~ '^sha256:[0-9a-f]{64}$'),
  action text NOT NULL CHECK (action = 'organization:portfolio:view'),
  target text NOT NULL CHECK (target = 'LIST' OR target ~ '^[0-9a-f-]{36}$'),
  decision text NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  policy_digest text NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL
);

ALTER TABLE control.tenant_harness_status_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.tenant_harness_status_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_harness_status_projection_isolation ON control.tenant_harness_status_projection
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.tenant_plane_status_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.tenant_plane_status_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_plane_status_projection_isolation ON control.tenant_plane_status_projection
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.tenant_overview_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.tenant_overview_projection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_overview_projection_isolation ON control.tenant_overview_projection
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.status_projection_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.status_projection_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY status_projection_cursor_isolation ON control.status_projection_cursor
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

ALTER TABLE control.status_projection_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.status_projection_finding FORCE ROW LEVEL SECURITY;
CREATE POLICY status_projection_finding_isolation ON control.status_projection_finding
  USING (organization_id = control.current_organization_id())
  WITH CHECK (organization_id = control.current_organization_id());

CREATE FUNCTION control.guard_status_cursor_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.source_id <> OLD.source_id OR
     NEW.source_sequence <> OLD.source_sequence + 1 OR NEW.source_cursor <= OLD.source_cursor OR
     NEW.source_event_id = OLD.source_event_id OR NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'STATUS_CURSOR_TRANSITION_REFUSED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER status_projection_cursor_monotonic
BEFORE UPDATE ON control.status_projection_cursor
FOR EACH ROW EXECUTE FUNCTION control.guard_status_cursor_transition();

CREATE TRIGGER status_projection_cursor_no_delete
BEFORE DELETE ON control.status_projection_cursor
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER status_projection_finding_append_only
BEFORE UPDATE OR DELETE ON control.status_projection_finding
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE TRIGGER status_projection_operator_audit_append_only
BEFORE UPDATE OR DELETE ON control.status_projection_operator_audit
FOR EACH ROW EXECUTE FUNCTION control.reject_append_only_mutation();

CREATE FUNCTION control.read_authorized_organization_portfolio(
  p_subject_digest text,
  p_policy_digest text,
  p_policy_allowed boolean,
  p_target_organization_id uuid,
  p_after_organization_id uuid,
  p_limit integer,
  p_aggregate_state text,
  p_occurred_at timestamptz,
  p_event_id text
) RETURNS TABLE (organization_id uuid, projection jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_subject_digest !~ '^sha256:[0-9a-f]{64}$' OR p_policy_digest !~ '^sha256:[0-9a-f]{64}$' OR
     p_limit NOT BETWEEN 1 AND 200 OR
     (p_aggregate_state IS NOT NULL AND p_aggregate_state NOT IN ('EMPTY', 'READY', 'DEGRADED', 'BLOCKED', 'FAILED', 'REVOKED')) THEN
    RAISE EXCEPTION 'OPERATOR_PORTFOLIO_INPUT_REFUSED';
  END IF;

  INSERT INTO control.status_projection_operator_audit
    (event_id, subject_digest, action, target, decision, policy_digest, occurred_at)
  VALUES
    (p_event_id, p_subject_digest, 'organization:portfolio:view', COALESCE(p_target_organization_id::text, 'LIST'),
     CASE WHEN p_policy_allowed THEN 'ALLOW' ELSE 'DENY' END, p_policy_digest, p_occurred_at);

  IF NOT p_policy_allowed THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT p.organization_id, p.projection
  FROM control.tenant_overview_projection AS p
  WHERE (p_target_organization_id IS NULL OR p.organization_id = p_target_organization_id)
    AND (p_after_organization_id IS NULL OR p.organization_id > p_after_organization_id)
    AND (p_aggregate_state IS NULL OR p.aggregate_state = p_aggregate_state)
  ORDER BY p.organization_id
  LIMIT p_limit;
END;
$$;

RESET ROLE;

REVOKE ALL ON control.status_projection_operator_audit FROM PUBLIC, control_runtime, control_compiler_worker, control_event_publisher;
REVOKE ALL ON FUNCTION control.read_authorized_organization_portfolio(text, text, boolean, uuid, uuid, integer, text, timestamptz, text) FROM PUBLIC, control_runtime, control_compiler_worker, control_event_publisher;
REVOKE ALL ON FUNCTION control.guard_status_cursor_transition() FROM PUBLIC;

GRANT SELECT, INSERT ON control.tenant_harness_status_projection, control.tenant_plane_status_projection,
  control.tenant_overview_projection, control.status_projection_cursor, control.status_projection_finding TO control_runtime;
GRANT UPDATE (observed_generation, profile_digest, bundle_digest, release_digest, aggregate_state,
  projected_at, fresh_until, projection_digest, projection)
  ON control.tenant_harness_status_projection TO control_runtime;
GRANT UPDATE (observed_generation, aggregate_state, projected_at, fresh_until, projection_digest, projection)
  ON control.tenant_plane_status_projection, control.tenant_overview_projection TO control_runtime;
GRANT UPDATE (source_sequence, source_cursor, source_event_id, source_content_digest, observed_at, state)
  ON control.status_projection_cursor TO control_runtime;

REVOKE DELETE, TRUNCATE ON control.tenant_harness_status_projection, control.tenant_plane_status_projection,
  control.tenant_overview_projection, control.status_projection_cursor, control.status_projection_finding,
  control.status_projection_operator_audit FROM control_runtime, control_compiler_worker, control_event_publisher;
REVOKE CREATE ON SCHEMA control FROM control_runtime, control_compiler_worker, control_event_publisher;

COMMIT;
