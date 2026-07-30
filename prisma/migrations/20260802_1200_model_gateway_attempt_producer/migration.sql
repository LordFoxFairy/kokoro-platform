-- Fresh-install Model Gateway producer state. No legacy usage_settle compatibility or dual writes.
CREATE TABLE platform.model_gateway_execution_authorization (
  authorization_handle TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  execution_manifest_ref TEXT NOT NULL CHECK (length(execution_manifest_ref) BETWEEN 1 AND 256),
  authorization_segment_ref UUID NOT NULL,
  gateway_model TEXT NOT NULL CHECK (length(gateway_model) BETWEEN 1 AND 256),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind = 'litellm'),
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_ref,execution_manifest_ref,authorization_segment_ref),
  UNIQUE (authorization_handle,site_ref,execution_manifest_ref,authorization_segment_ref,gateway_model),
  FOREIGN KEY (site_ref,execution_manifest_ref)
    REFERENCES platform.admission_execution_manifest(site_id,manifest_ref),
  FOREIGN KEY (authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  CHECK (authorization_handle ~ '^model-authorization:sha256:[0-9a-f]{64}$'),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_gateway_invocation (
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  invocation_ref UUID NOT NULL,
  authorization_handle TEXT NOT NULL,
  execution_manifest_ref TEXT NOT NULL CHECK (length(execution_manifest_ref) BETWEEN 1 AND 256),
  authorization_segment_ref UUID NOT NULL,
  logical_call_ref TEXT NOT NULL CHECK (length(logical_call_ref) BETWEEN 1 AND 256),
  attempt_ref TEXT NOT NULL CHECK (length(attempt_ref) BETWEEN 1 AND 256),
  producer_context TEXT NOT NULL CHECK (length(producer_context) BETWEEN 1 AND 256),
  producer_generation BIGINT NOT NULL CHECK (producer_generation > 0),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  gateway_model TEXT NOT NULL CHECK (length(gateway_model) BETWEEN 1 AND 256),
  maximum_dimensions JSONB NOT NULL CHECK (jsonb_typeof(maximum_dimensions)='array'
    AND jsonb_array_length(maximum_dimensions) BETWEEN 1 AND 64),
  attempt_authorization_ref UUID NOT NULL,
  fence_epoch BIGINT NOT NULL CHECK (fence_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('dispatching','succeeded','failed','outcome_unknown')),
  response_envelope JSONB CHECK (response_envelope IS NULL OR jsonb_typeof(response_envelope)='object'),
  evidence_ref UUID,
  source_digest CHAR(64) CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
  owner_evidence_ref TEXT CHECK (owner_evidence_ref IS NULL OR length(owner_evidence_ref) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (site_ref,invocation_ref),
  UNIQUE (site_ref,logical_call_ref),
  UNIQUE (site_ref,attempt_authorization_ref),
  FOREIGN KEY (authorization_handle,site_ref,execution_manifest_ref,authorization_segment_ref,gateway_model)
    REFERENCES platform.model_gateway_execution_authorization(
      authorization_handle,site_ref,execution_manifest_ref,authorization_segment_ref,gateway_model
    ),
  FOREIGN KEY (attempt_authorization_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_attempt_intent(
      attempt_authorization_ref,site_ref,authorization_segment_ref
    ),
  CHECK (
    (state='dispatching' AND response_envelope IS NULL AND evidence_ref IS NULL AND owner_evidence_ref IS NULL)
    OR (state IN ('succeeded','failed') AND response_envelope IS NOT NULL AND evidence_ref IS NOT NULL
        AND source_digest IS NOT NULL AND owner_evidence_ref IS NULL)
    OR (state='outcome_unknown' AND response_envelope IS NULL AND evidence_ref IS NULL
        AND source_digest IS NULL AND owner_evidence_ref IS NOT NULL)
  ),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_gateway_attempt_usage_fact (
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  evidence_ref UUID NOT NULL,
  invocation_ref UUID NOT NULL,
  attempt_authorization_ref UUID NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('measured','unavailable')),
  dimensions JSONB NOT NULL CHECK (jsonb_typeof(dimensions)='array'
    AND jsonb_array_length(dimensions) BETWEEN 0 AND 64),
  attempt_outcome TEXT NOT NULL CHECK (attempt_outcome IN ('succeeded','failed_after_effect')),
  source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_ref,evidence_ref),
  UNIQUE (site_ref,invocation_ref),
  FOREIGN KEY (site_ref,invocation_ref)
    REFERENCES platform.model_gateway_invocation(site_ref,invocation_ref),
  FOREIGN KEY (evidence_ref,site_ref)
    REFERENCES platform.credit_attempt_usage_evidence(evidence_ref,site_ref),
  FOREIGN KEY (attempt_authorization_ref,site_ref)
    REFERENCES platform.credit_usage_attempt_intent(attempt_authorization_ref,site_ref)
);

CREATE TABLE platform.model_gateway_outbox (
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  event_ref UUID NOT NULL,
  aggregate_ref UUID NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'model_gateway.invocation_prepared.v1',
    'model_gateway.invocation_finalized.v1',
    'model_gateway.invocation_outcome_unknown.v1'
  )),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (site_ref,event_ref),
  FOREIGN KEY (site_ref,aggregate_ref)
    REFERENCES platform.model_gateway_invocation(site_ref,invocation_ref)
);

CREATE INDEX model_gateway_invocation_reconcile_idx
  ON platform.model_gateway_invocation(state,updated_at,site_ref)
  WHERE state IN ('dispatching','outcome_unknown');
CREATE INDEX model_gateway_outbox_publish_idx
  ON platform.model_gateway_outbox(created_at,site_ref,event_ref)
  WHERE published_at IS NULL;

CREATE FUNCTION platform.resolve_model_gateway_authorization(requested_handle TEXT, requested_operation TEXT)
RETURNS TABLE (
  authorization_handle TEXT,
  site_ref TEXT,
  execution_manifest_ref TEXT,
  authorization_segment_ref TEXT,
  gateway_model TEXT,
  adapter_kind TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$
  SELECT authorization.authorization_handle,authorization.site_ref,
         authorization.execution_manifest_ref,authorization.authorization_segment_ref,
         authorization.gateway_model,authorization.adapter_kind,authorization.expires_at
  FROM platform.model_gateway_execution_authorization authorization
  WHERE authorization.authorization_handle=requested_handle
    AND authorization.adapter_kind='litellm'
    AND (
      (requested_operation='prepare' AND authorization.state='active'
        AND authorization.expires_at>clock_timestamp())
      OR (requested_operation IN ('finalize','unknown')
        AND authorization.state IN ('active','revoked','expired'))
    )
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION platform.resolve_model_gateway_authorization(TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.guard_model_gateway_authorization_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $$
BEGIN
  IF OLD.authorization_handle IS DISTINCT FROM NEW.authorization_handle
     OR OLD.site_ref IS DISTINCT FROM NEW.site_ref
     OR OLD.execution_manifest_ref IS DISTINCT FROM NEW.execution_manifest_ref
     OR OLD.authorization_segment_ref IS DISTINCT FROM NEW.authorization_segment_ref
     OR OLD.gateway_model IS DISTINCT FROM NEW.gateway_model
     OR OLD.adapter_kind IS DISTINCT FROM NEW.adapter_kind
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'MODEL_GATEWAY_AUTHORIZATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT (
    OLD.state=NEW.state
    OR (OLD.state='active' AND NEW.state IN ('revoked','expired'))
    OR (OLD.state='revoked' AND NEW.state='expired')
  ) THEN RAISE EXCEPTION 'MODEL_GATEWAY_AUTHORIZATION_TRANSITION_INVALID';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'MODEL_GATEWAY_AUTHORIZATION_TIME_INVALID';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.guard_model_gateway_authorization_transition() FROM PUBLIC;
CREATE TRIGGER model_gateway_authorization_transition
BEFORE UPDATE ON platform.model_gateway_execution_authorization
FOR EACH ROW EXECUTE FUNCTION platform.guard_model_gateway_authorization_transition();

CREATE FUNCTION platform.guard_model_gateway_invocation_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $$
BEGIN
  IF OLD.site_ref IS DISTINCT FROM NEW.site_ref
     OR OLD.invocation_ref IS DISTINCT FROM NEW.invocation_ref
     OR OLD.authorization_handle IS DISTINCT FROM NEW.authorization_handle
     OR OLD.execution_manifest_ref IS DISTINCT FROM NEW.execution_manifest_ref
     OR OLD.authorization_segment_ref IS DISTINCT FROM NEW.authorization_segment_ref
     OR OLD.logical_call_ref IS DISTINCT FROM NEW.logical_call_ref
     OR OLD.attempt_ref IS DISTINCT FROM NEW.attempt_ref
     OR OLD.producer_context IS DISTINCT FROM NEW.producer_context
     OR OLD.producer_generation IS DISTINCT FROM NEW.producer_generation
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.gateway_model IS DISTINCT FROM NEW.gateway_model
     OR OLD.maximum_dimensions IS DISTINCT FROM NEW.maximum_dimensions
     OR OLD.attempt_authorization_ref IS DISTINCT FROM NEW.attempt_authorization_ref
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT (
    OLD.state='dispatching' AND NEW.state IN ('succeeded','failed','outcome_unknown')
    OR (OLD.state='outcome_unknown' AND NEW.state IN ('succeeded','failed'))
  ) THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_TRANSITION_INVALID';
  END IF;
  IF NEW.fence_epoch <> OLD.fence_epoch+1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_FENCE_INVALID';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.guard_model_gateway_invocation_transition() FROM PUBLIC;
CREATE TRIGGER model_gateway_invocation_transition
BEFORE UPDATE ON platform.model_gateway_invocation
FOR EACH ROW EXECUTE FUNCTION platform.guard_model_gateway_invocation_transition();

CREATE FUNCTION platform.reject_model_gateway_owned_delete() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $$
BEGIN
  RAISE EXCEPTION 'MODEL_GATEWAY_OWNED_DELETE_FORBIDDEN';
END
$$;
REVOKE ALL ON FUNCTION platform.reject_model_gateway_owned_delete() FROM PUBLIC;

CREATE TRIGGER model_gateway_invocation_no_delete
BEFORE DELETE ON platform.model_gateway_invocation
FOR EACH ROW EXECUTE FUNCTION platform.reject_model_gateway_owned_delete();
CREATE TRIGGER model_gateway_execution_authorization_no_delete
BEFORE DELETE ON platform.model_gateway_execution_authorization
FOR EACH ROW EXECUTE FUNCTION platform.reject_model_gateway_owned_delete();
CREATE TRIGGER model_gateway_attempt_usage_fact_immutable
BEFORE UPDATE OR DELETE ON platform.model_gateway_attempt_usage_fact
FOR EACH ROW EXECUTE FUNCTION platform.reject_model_gateway_owned_delete();
CREATE TRIGGER model_gateway_outbox_no_delete
BEFORE DELETE ON platform.model_gateway_outbox
FOR EACH ROW EXECUTE FUNCTION platform.reject_model_gateway_owned_delete();

ALTER TABLE platform.model_gateway_invocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_gateway_invocation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.model_gateway_attempt_usage_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_gateway_attempt_usage_fact FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.model_gateway_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_gateway_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY model_gateway_invocation_site_scope ON platform.model_gateway_invocation
  USING (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway')
  WITH CHECK (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway');
CREATE POLICY model_gateway_attempt_usage_fact_site_scope ON platform.model_gateway_attempt_usage_fact
  USING (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway')
  WITH CHECK (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway');
CREATE POLICY model_gateway_outbox_site_scope ON platform.model_gateway_outbox
  USING (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway')
  WITH CHECK (site_ref=current_setting('app.site_id',true)
    AND current_setting('app.workload_kind',true)='platform_model_gateway');
