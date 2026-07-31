-- Fresh-install Model Gateway image-effect authority. Forward-only; no legacy rows exist.
CREATE TABLE platform.model_image_effect_access_authorization (
  caller_access_handle_digest TEXT PRIMARY KEY CHECK (caller_access_handle_digest ~ '^[0-9a-f]{64}$'),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  audience TEXT NOT NULL CHECK (audience='platform-media-worker'),
  workload_identity_ref TEXT NOT NULL CHECK (length(workload_identity_ref) BETWEEN 1 AND 256),
  environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 128),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 128),
  authorization_generation BIGINT NOT NULL CHECK (authorization_generation>0),
  security_epoch BIGINT NOT NULL CHECK (security_epoch>0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (caller_identity,site_ref),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_source_grant_authorization (
  purpose_grant_handle_digest TEXT PRIMARY KEY
    CHECK (purpose_grant_handle_digest ~ '^[0-9a-f]{64}$'),
  caller_access_handle_digest TEXT NOT NULL REFERENCES
    platform.model_image_effect_access_authorization(caller_access_handle_digest),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  source_version_ref TEXT NOT NULL CHECK (length(source_version_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (caller_access_handle_digest,source_version_ref),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_option_authorization (
  model_option_authorization_handle_digest TEXT PRIMARY KEY
    CHECK (model_option_authorization_handle_digest ~ '^[0-9a-f]{64}$'),
  caller_access_handle_digest TEXT NOT NULL REFERENCES
    platform.model_image_effect_access_authorization(caller_access_handle_digest),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  model_option_revision_ref TEXT NOT NULL CHECK (length(model_option_revision_ref) BETWEEN 1 AND 256),
  definition_role_ref TEXT NOT NULL CHECK (length(definition_role_ref) BETWEEN 1 AND 256),
  deployment_ref TEXT NOT NULL CHECK (length(deployment_ref) BETWEEN 1 AND 256),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind='certified-image-v1'),
  provider_model TEXT NOT NULL CHECK (length(provider_model) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_option_authorization_handle_digest,caller_identity,site_ref,model_option_revision_ref),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_effect_budget_commit (
  budget_commit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  effect_budget_commit_ref TEXT NOT NULL UNIQUE CHECK (length(effect_budget_commit_ref) BETWEEN 1 AND 256),
  effect_budget_commit_digest TEXT NOT NULL CHECK (effect_budget_commit_digest ~ '^[0-9a-f]{64}$'),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  model_option_revision_ref TEXT NOT NULL CHECK (length(model_option_revision_ref) BETWEEN 1 AND 256),
  deployment_ref TEXT NOT NULL CHECK (length(deployment_ref) BETWEEN 1 AND 256),
  model_invocation_command_ref TEXT NOT NULL CHECK (length(model_invocation_command_ref) BETWEEN 1 AND 256),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 64),
  operation_input_revision_ref TEXT NOT NULL CHECK (length(operation_input_revision_ref) BETWEEN 1 AND 256),
  operation_input_revision_digest TEXT NOT NULL CHECK (operation_input_revision_digest ~ '^[0-9a-f]{64}$'),
  logical_output_slots JSONB NOT NULL CHECK (jsonb_typeof(logical_output_slots)='array'),
  logical_output_slots_digest TEXT NOT NULL CHECK (logical_output_slots_digest ~ '^[0-9a-f]{64}$'),
  issuer_key_revision TEXT NOT NULL CHECK (length(issuer_key_revision) BETWEEN 1 AND 128),
  signed_receipt_envelope BYTEA NOT NULL CHECK (octet_length(signed_receipt_envelope) BETWEEN 64 AND 65536),
  signed_receipt_digest TEXT NOT NULL CHECK (signed_receipt_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('verified_available','consumed','expired','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_logical_invocation_ref TEXT,
  consumed_attempt_ref TEXT,
  consumed_owner_command_digest TEXT CHECK (
    consumed_owner_command_digest IS NULL OR consumed_owner_command_digest ~ '^[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (effect_budget_commit_ref,effect_budget_commit_digest),
  CHECK ((state='consumed') = (consumed_logical_invocation_ref IS NOT NULL)),
  CHECK ((state='consumed') = (consumed_attempt_ref IS NOT NULL)),
  CHECK ((state='consumed') = (consumed_owner_command_digest IS NOT NULL)),
  CHECK ((state='consumed') = (consumed_at IS NOT NULL)),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_effect_invocation (
  logical_invocation_ref TEXT PRIMARY KEY CHECK (length(logical_invocation_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  caller_access_handle_digest TEXT NOT NULL CHECK (caller_access_handle_digest ~ '^[0-9a-f]{64}$'),
  model_option_authorization_handle_digest TEXT NOT NULL
    CHECK (model_option_authorization_handle_digest ~ '^[0-9a-f]{64}$'),
  model_invocation_command_ref TEXT NOT NULL CHECK (length(model_invocation_command_ref) BETWEEN 1 AND 256),
  owner_version BIGINT NOT NULL CHECK (owner_version>0),
  state TEXT NOT NULL CHECK (state IN (
    'accepted','submitted','definitely_not_submitted','submission_unknown','running','succeeded','failed',
    'cancel_requested','canceled','outcome_unknown')),
  definition_role_ref TEXT NOT NULL CHECK (length(definition_role_ref) BETWEEN 1 AND 256),
  model_option_revision_ref TEXT NOT NULL CHECK (length(model_option_revision_ref) BETWEEN 1 AND 256),
  deployment_ref TEXT NOT NULL CHECK (length(deployment_ref) BETWEEN 1 AND 256),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind='certified-image-v1'),
  provider_model TEXT NOT NULL CHECK (length(provider_model) BETWEEN 1 AND 256),
  model_authorization_expires_at TIMESTAMPTZ NOT NULL,
  operation_input_revision_ref TEXT NOT NULL CHECK (length(operation_input_revision_ref) BETWEEN 1 AND 256),
  operation_input_revision_digest TEXT NOT NULL CHECK (operation_input_revision_digest ~ '^[0-9a-f]{64}$'),
  source_grant_refs JSONB NOT NULL CHECK (jsonb_typeof(source_grant_refs)='array'),
  source_grants JSONB NOT NULL CHECK (jsonb_typeof(source_grants)='object'),
  logical_output_slots JSONB NOT NULL CHECK (jsonb_typeof(logical_output_slots)='array'),
  trust_effect_allow_receipt_ref TEXT NOT NULL CHECK (length(trust_effect_allow_receipt_ref) BETWEEN 1 AND 256),
  trust_effect_allow_receipt_digest TEXT NOT NULL CHECK (trust_effect_allow_receipt_digest ~ '^[0-9a-f]{64}$'),
  current_attempt_ordinal INTEGER NOT NULL CHECK (current_attempt_ordinal BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (caller_identity,model_invocation_command_ref),
  FOREIGN KEY (caller_access_handle_digest) REFERENCES
    platform.model_image_effect_access_authorization(caller_access_handle_digest),
  FOREIGN KEY (model_option_authorization_handle_digest) REFERENCES
    platform.model_image_option_authorization(model_option_authorization_handle_digest),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_effect_attempt (
  attempt_ref TEXT PRIMARY KEY CHECK (length(attempt_ref) BETWEEN 1 AND 256),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 64),
  effect_budget_commit_ref TEXT NOT NULL UNIQUE,
  effect_budget_commit_digest TEXT NOT NULL CHECK (effect_budget_commit_digest ~ '^[0-9a-f]{64}$'),
  provider_operation_key TEXT NOT NULL UNIQUE CHECK (length(provider_operation_key) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN (
    'planned','definitely_not_submitted','submitted','submission_unknown','running',
    'succeeded','failed','canceled','outcome_unknown')),
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  provider_operation_ref TEXT,
  definitely_not_submitted_receipt_ref TEXT,
  definitely_not_submitted_receipt_digest TEXT CHECK (
    definitely_not_submitted_receipt_digest IS NULL OR definitely_not_submitted_receipt_digest ~ '^[0-9a-f]{64}$'),
  canonical_outcome_evidence_ref TEXT,
  canonical_outcome_evidence_digest TEXT CHECK (
    canonical_outcome_evidence_digest IS NULL OR canonical_outcome_evidence_digest ~ '^[0-9a-f]{64}$'),
  usage_evidence_ref TEXT,
  usage_evidence_digest TEXT CHECK (usage_evidence_digest IS NULL OR usage_evidence_digest ~ '^[0-9a-f]{64}$'),
  last_provider_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_provider_sequence>=0),
  late_outcome BOOLEAN NOT NULL DEFAULT FALSE,
  dispatch_owner_ref TEXT CHECK (dispatch_owner_ref IS NULL OR length(dispatch_owner_ref) BETWEEN 1 AND 128),
  dispatch_fence BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_fence>=0),
  dispatch_lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (logical_invocation_ref,attempt_ordinal),
  FOREIGN KEY (effect_budget_commit_ref,effect_budget_commit_digest) REFERENCES
    platform.model_image_effect_budget_commit(effect_budget_commit_ref,effect_budget_commit_digest),
  CHECK ((state='definitely_not_submitted') = (definitely_not_submitted_receipt_ref IS NOT NULL)),
  CHECK ((state='definitely_not_submitted') = (definitely_not_submitted_receipt_digest IS NOT NULL)),
  CHECK ((dispatch_owner_ref IS NULL) = (dispatch_lease_expires_at IS NULL)),
  CHECK (created_at<=updated_at)
);

CREATE TABLE platform.model_image_effect_command_journal (
  command_journal_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  caller_access_handle_digest TEXT NOT NULL CHECK (caller_access_handle_digest ~ '^[0-9a-f]{64}$'),
  caller_command_ref TEXT NOT NULL CHECK (length(caller_command_ref) BETWEEN 1 AND 256),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('create','cancel','attach_attempt')),
  owner_command_digest TEXT NOT NULL CHECK (owner_command_digest ~ '^[0-9a-f]{64}$'),
  caller_request_fingerprint TEXT NOT NULL CHECK (caller_request_fingerprint ~ '^[0-9a-f]{64}$'),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  attempt_ref TEXT NOT NULL REFERENCES platform.model_image_effect_attempt(attempt_ref),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 64),
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN (
    'create_committed','attempt_authorization_attached','cancel_intent_committed')),
  receipt_version BIGINT NOT NULL CHECK (receipt_version>0),
  recorded_at TIMESTAMPTZ NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  receipt_ref TEXT NOT NULL UNIQUE CHECK (
    receipt_ref ~ '^image-effect-receipt:sha256:[0-9a-f]{64}$'),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (caller_identity,caller_command_ref)
);

CREATE TABLE platform.model_image_effect_provider_observation (
  observation_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  attempt_ref TEXT NOT NULL REFERENCES platform.model_image_effect_attempt(attempt_ref),
  provider_event_ref TEXT NOT NULL CHECK (length(provider_event_ref) BETWEEN 1 AND 256),
  provider_sequence BIGINT NOT NULL CHECK (provider_sequence>0),
  observation_kind TEXT NOT NULL CHECK (observation_kind IN (
    'definitely_not_submitted','submitted','submission_unknown','running',
    'succeeded','failed','canceled','outcome_unknown')),
  observation_digest TEXT NOT NULL CHECK (observation_digest ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (attempt_ref,provider_sequence),
  UNIQUE (attempt_ref,provider_event_ref)
);

CREATE TABLE platform.model_image_effect_output_evidence (
  output_evidence_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  attempt_ref TEXT NOT NULL REFERENCES platform.model_image_effect_attempt(attempt_ref),
  candidate_ref TEXT NOT NULL CHECK (length(candidate_ref) BETWEEN 1 AND 256),
  stable_output_slot_ref TEXT NOT NULL CHECK (length(stable_output_slot_ref) BETWEEN 1 AND 256),
  provider_output_fact_ref TEXT NOT NULL CHECK (length(provider_output_fact_ref) BETWEEN 1 AND 256),
  retrieval_grant_handle_digest TEXT NOT NULL CHECK (retrieval_grant_handle_digest ~ '^[0-9a-f]{64}$'),
  retrieval_grant_envelope JSONB NOT NULL CHECK (jsonb_typeof(retrieval_grant_envelope)='object'),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (attempt_ref,candidate_ref),
  UNIQUE (attempt_ref,stable_output_slot_ref),
  UNIQUE (attempt_ref,provider_output_fact_ref)
);

CREATE TABLE platform.model_image_effect_dispatch_queue (
  attempt_ref TEXT PRIMARY KEY REFERENCES platform.model_image_effect_attempt(attempt_ref),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  state TEXT NOT NULL CHECK (state IN ('queued','leased','terminal','dead_letter')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatch_owner_ref TEXT CHECK (dispatch_owner_ref IS NULL OR length(dispatch_owner_ref) BETWEEN 1 AND 128),
  dispatch_fence BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_fence>=0),
  dispatch_lease_expires_at TIMESTAMPTZ,
  delivery_attempt INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempt BETWEEN 0 AND 64),
  last_error_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((dispatch_owner_ref IS NULL) = (dispatch_lease_expires_at IS NULL))
);

CREATE INDEX model_image_effect_dispatch_ready_idx
  ON platform.model_image_effect_dispatch_queue(available_at,attempt_ref)
  WHERE state='queued';
CREATE INDEX model_image_effect_dispatch_reclaim_idx
  ON platform.model_image_effect_dispatch_queue(dispatch_lease_expires_at,attempt_ref)
  WHERE state='leased';

CREATE TABLE platform.model_image_effect_outbox (
  event_ref TEXT PRIMARY KEY CHECK (length(event_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'image_effect.created.v1','image_effect.attempt_attached.v1',
    'image_effect.cancel_requested.v1','image_effect.observed.v1')),
  evidence_revision BIGINT NOT NULL CHECK (evidence_revision>0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (logical_invocation_ref,event_kind,evidence_revision)
);

-- Runtime and cross-Site worker are distinct PostgreSQL principals. OID pinning
-- prevents a dropped/recreated role with the same name from inheriting authority.
CREATE TABLE platform.model_image_effect_runtime_role_identity (
  role_kind TEXT PRIMARY KEY CHECK (role_kind IN ('runtime','worker')),
  role_name NAME NOT NULL UNIQUE,
  role_oid OID NOT NULL UNIQUE,
  CHECK ((role_kind='runtime' AND role_name='platform_model_gateway') OR
         (role_kind='worker' AND role_name='platform_model_image_worker'))
);
INSERT INTO platform.model_image_effect_runtime_role_identity(role_kind,role_name,role_oid)
SELECT 'runtime',rolname,oid FROM pg_roles WHERE rolname='platform_model_gateway'
UNION ALL
SELECT 'worker',rolname,oid FROM pg_roles WHERE rolname='platform_model_image_worker';
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.model_image_effect_runtime_role_identity)<>2 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_RUNTIME_ROLES_MISSING';
  END IF;
END $$;
ALTER TABLE platform.model_image_effect_runtime_role_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_image_effect_runtime_role_identity FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.model_image_effect_runtime_role_identity FROM PUBLIC;
CREATE POLICY model_image_effect_role_identity_definer
  ON platform.model_image_effect_runtime_role_identity TO platform_migrator
  USING (SESSION_USER IN ('platform_model_gateway','platform_model_image_worker'));

CREATE FUNCTION platform.assert_model_image_effect_runtime_role(expected_kind TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE expected_name NAME; expected_oid OID; actual_oid OID;
BEGIN
  SELECT role_name,role_oid INTO STRICT expected_name,expected_oid
    FROM platform.model_image_effect_runtime_role_identity WHERE role_kind=expected_kind;
  SELECT oid INTO STRICT actual_oid FROM pg_roles WHERE rolname=SESSION_USER;
  IF SESSION_USER<>expected_name::TEXT OR actual_oid<>expected_oid THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_RUNTIME_ROLE_FORBIDDEN';
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.assert_model_image_effect_runtime_role(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.assert_model_image_effect_runtime_role(TEXT)
  TO platform_model_gateway,platform_model_image_worker;

CREATE FUNCTION platform.resolve_model_image_effect_access(
  requested_access_digest TEXT,
  requested_operation TEXT
) RETURNS TABLE (
  caller_access_handle_digest TEXT,
  caller_identity TEXT,
  site_ref TEXT,
  caller_audience TEXT,
  workload_identity_ref TEXT,
  environment TEXT,
  region TEXT,
  authorization_generation BIGINT,
  security_epoch BIGINT,
  expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('runtime');
  RETURN QUERY SELECT access.caller_access_handle_digest,access.caller_identity,access.site_ref,access.audience,
         access.workload_identity_ref,access.environment,access.region,
         access.authorization_generation,access.security_epoch,access.expires_at
    FROM platform.model_image_effect_access_authorization access
   WHERE access.caller_access_handle_digest=requested_access_digest
     AND access.state='active' AND access.expires_at>statement_timestamp()
     AND requested_operation IN ('create','recover','get','cancel','attach');
END $$;
REVOKE ALL ON FUNCTION platform.resolve_model_image_effect_access(TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.resolve_model_image_source_grant_authorizations(
  requested_access_digest TEXT,
  requested_source_refs TEXT[],
  requested_grant_digests TEXT[]
) RETURNS TABLE (
  source_version_ref TEXT,
  purpose_grant_handle_digest TEXT,
  expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('runtime');
  IF cardinality(requested_source_refs)<>cardinality(requested_grant_digests)
     OR cardinality(requested_source_refs)>16
     OR EXISTS (SELECT 1 FROM unnest(requested_source_refs) value GROUP BY value HAVING count(*)>1)
     OR EXISTS (SELECT 1 FROM unnest(requested_grant_digests) value GROUP BY value HAVING count(*)>1) THEN
    RAISE EXCEPTION 'MODEL_IMAGE_SOURCE_GRANT_REQUEST_INVALID';
  END IF;
  RETURN QUERY
    SELECT grant_auth.source_version_ref,grant_auth.purpose_grant_handle_digest,grant_auth.expires_at
      FROM unnest(requested_source_refs,requested_grant_digests) WITH ORDINALITY
           requested(source_ref,grant_digest,ordinal)
      JOIN platform.model_image_source_grant_authorization grant_auth
        ON grant_auth.source_version_ref=requested.source_ref
       AND grant_auth.purpose_grant_handle_digest=requested.grant_digest
       AND grant_auth.caller_access_handle_digest=requested_access_digest
     WHERE grant_auth.state='active' AND grant_auth.expires_at>statement_timestamp()
     ORDER BY requested.ordinal;
END $$;
REVOKE ALL ON FUNCTION platform.resolve_model_image_source_grant_authorizations(TEXT,TEXT[],TEXT[])
  FROM PUBLIC;

CREATE FUNCTION platform.resolve_model_image_option_authorization(
  requested_access_digest TEXT,
  requested_model_digest TEXT
) RETURNS TABLE (
  model_option_authorization_handle_digest TEXT,
  model_option_revision_ref TEXT,
  definition_role_ref TEXT,
  deployment_ref TEXT,
  adapter_kind TEXT,
  provider_model TEXT,
  expires_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('runtime');
  RETURN QUERY SELECT model.model_option_authorization_handle_digest,model.model_option_revision_ref,
         model.definition_role_ref,model.deployment_ref,model.adapter_kind,model.provider_model,model.expires_at
    FROM platform.model_image_option_authorization model
   WHERE model.caller_access_handle_digest=requested_access_digest
     AND model.model_option_authorization_handle_digest=requested_model_digest
     AND model.state='active' AND model.expires_at>statement_timestamp();
END $$;
REVOKE ALL ON FUNCTION platform.resolve_model_image_option_authorization(TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.consume_model_image_effect_budget_commit(
  requested_site_ref TEXT,
  requested_caller_identity TEXT,
  requested_commit_ref TEXT,
  requested_commit_digest TEXT,
  requested_command_ref TEXT,
  requested_attempt_ordinal INTEGER,
  requested_model_option_ref TEXT,
  requested_deployment_ref TEXT,
  requested_input_ref TEXT,
  requested_input_digest TEXT,
  requested_slots_digest TEXT,
  requested_invocation_ref TEXT,
  requested_attempt_ref TEXT,
  requested_owner_digest TEXT
) RETURNS TABLE (
  effect_budget_commit_ref TEXT,
  effect_budget_commit_digest TEXT,
  attempt_ordinal INTEGER,
  expires_at TIMESTAMPTZ,
  replayed BOOLEAN
) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('runtime');
  UPDATE platform.model_image_effect_budget_commit budget
     SET state='consumed',consumed_logical_invocation_ref=requested_invocation_ref,
         consumed_attempt_ref=requested_attempt_ref,consumed_owner_command_digest=requested_owner_digest,
         consumed_at=statement_timestamp(),updated_at=statement_timestamp()
   WHERE budget.site_ref=requested_site_ref AND budget.caller_identity=requested_caller_identity
     AND budget.effect_budget_commit_ref=requested_commit_ref
     AND budget.effect_budget_commit_digest=requested_commit_digest
     AND budget.model_invocation_command_ref=requested_command_ref
     AND budget.attempt_ordinal=requested_attempt_ordinal
     AND budget.model_option_revision_ref=requested_model_option_ref
     AND budget.deployment_ref=requested_deployment_ref
     AND budget.operation_input_revision_ref=requested_input_ref
     AND budget.operation_input_revision_digest=requested_input_digest
     AND budget.logical_output_slots_digest=requested_slots_digest
     AND budget.state='verified_available' AND budget.expires_at>statement_timestamp();
  IF FOUND THEN
    RETURN QUERY SELECT requested_commit_ref,requested_commit_digest,requested_attempt_ordinal,
      budget.expires_at,FALSE FROM platform.model_image_effect_budget_commit budget
      WHERE budget.effect_budget_commit_ref=requested_commit_ref;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT budget.effect_budget_commit_ref,budget.effect_budget_commit_digest,budget.attempt_ordinal,
           budget.expires_at,TRUE
      FROM platform.model_image_effect_budget_commit budget
     WHERE budget.effect_budget_commit_ref=requested_commit_ref
       AND budget.effect_budget_commit_digest=requested_commit_digest
       AND budget.site_ref=requested_site_ref AND budget.caller_identity=requested_caller_identity
       AND budget.model_invocation_command_ref=requested_command_ref
       AND budget.attempt_ordinal=requested_attempt_ordinal
       AND budget.model_option_revision_ref=requested_model_option_ref
       AND budget.deployment_ref=requested_deployment_ref
       AND budget.operation_input_revision_ref=requested_input_ref
       AND budget.operation_input_revision_digest=requested_input_digest
       AND budget.logical_output_slots_digest=requested_slots_digest
       AND budget.state='consumed'
       AND budget.consumed_logical_invocation_ref=requested_invocation_ref
       AND budget.consumed_attempt_ref=requested_attempt_ref
       AND budget.consumed_owner_command_digest=requested_owner_digest;
END $$;
REVOKE ALL ON FUNCTION platform.consume_model_image_effect_budget_commit(
  TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.claim_model_image_effect_dispatch(
  requested_owner_ref TEXT,
  requested_lease_milliseconds INTEGER
) RETURNS TABLE (attempt_ref TEXT,logical_invocation_ref TEXT,dispatch_fence BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE selected_attempt_ref TEXT; selected_invocation_ref TEXT; next_fence BIGINT;
  lease_until TIMESTAMPTZ; changed_count INTEGER;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF length(requested_owner_ref) NOT BETWEEN 1 AND 128 OR
     requested_lease_milliseconds NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_DISPATCH_LEASE_INVALID';
  END IF;
  SELECT queue.attempt_ref,queue.logical_invocation_ref,queue.dispatch_fence+1
    INTO selected_attempt_ref,selected_invocation_ref,next_fence
    FROM platform.model_image_effect_dispatch_queue queue
    JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=queue.attempt_ref
   WHERE ((queue.state='queued' AND queue.available_at<=statement_timestamp())
      OR (queue.state='leased' AND queue.dispatch_lease_expires_at<=statement_timestamp()))
     AND queue.delivery_attempt<64
     AND attempt.dispatch_fence=queue.dispatch_fence
     AND attempt.dispatch_owner_ref IS NOT DISTINCT FROM queue.dispatch_owner_ref
     AND attempt.dispatch_lease_expires_at IS NOT DISTINCT FROM queue.dispatch_lease_expires_at
   ORDER BY queue.available_at,queue.attempt_ref FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  lease_until := statement_timestamp()+make_interval(secs=>requested_lease_milliseconds/1000.0);
  UPDATE platform.model_image_effect_dispatch_queue queue
     SET state='leased',dispatch_owner_ref=requested_owner_ref,dispatch_fence=next_fence,
         dispatch_lease_expires_at=lease_until,delivery_attempt=delivery_attempt+1,
         updated_at=statement_timestamp()
   WHERE queue.attempt_ref=selected_attempt_ref;
  GET DIAGNOSTICS changed_count=ROW_COUNT;
  IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_QUEUE_CLAIM_INCONSISTENT'; END IF;
  UPDATE platform.model_image_effect_attempt attempt
     SET dispatch_owner_ref=requested_owner_ref,dispatch_fence=next_fence,
         dispatch_lease_expires_at=lease_until,heartbeat_at=statement_timestamp(),
         updated_at=statement_timestamp()
   WHERE attempt.attempt_ref=selected_attempt_ref
     AND attempt.logical_invocation_ref=selected_invocation_ref;
  GET DIAGNOSTICS changed_count=ROW_COUNT;
  IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_ATTEMPT_CLAIM_INCONSISTENT'; END IF;
  RETURN QUERY SELECT selected_attempt_ref,selected_invocation_ref,next_fence;
END $$;
REVOKE ALL ON FUNCTION platform.claim_model_image_effect_dispatch(TEXT,INTEGER) FROM PUBLIC;

CREATE FUNCTION platform.heartbeat_model_image_effect_dispatch(
  requested_attempt_ref TEXT,
  requested_owner_ref TEXT,
  requested_fence BIGINT,
  requested_lease_milliseconds INTEGER
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE changed_count INTEGER; lease_until TIMESTAMPTZ;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF length(requested_owner_ref) NOT BETWEEN 1 AND 128 OR requested_fence<1 OR
     requested_lease_milliseconds NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_DISPATCH_LEASE_INVALID';
  END IF;
  PERFORM 1 FROM platform.model_image_effect_dispatch_queue queue
    JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=queue.attempt_ref
   WHERE queue.attempt_ref=requested_attempt_ref AND queue.state='leased'
     AND queue.dispatch_owner_ref=requested_owner_ref AND queue.dispatch_fence=requested_fence
     AND queue.dispatch_lease_expires_at>statement_timestamp()
     AND attempt.dispatch_owner_ref=requested_owner_ref AND attempt.dispatch_fence=requested_fence
     AND attempt.dispatch_lease_expires_at>statement_timestamp()
   FOR UPDATE OF queue,attempt;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  lease_until := statement_timestamp()+make_interval(secs=>requested_lease_milliseconds/1000.0);
  UPDATE platform.model_image_effect_dispatch_queue queue
     SET dispatch_lease_expires_at=lease_until,updated_at=statement_timestamp()
   WHERE queue.attempt_ref=requested_attempt_ref;
  GET DIAGNOSTICS changed_count=ROW_COUNT;
  IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_QUEUE_HEARTBEAT_INCONSISTENT'; END IF;
  UPDATE platform.model_image_effect_attempt attempt
     SET dispatch_lease_expires_at=lease_until,heartbeat_at=statement_timestamp(),updated_at=statement_timestamp()
   WHERE attempt.attempt_ref=requested_attempt_ref;
  GET DIAGNOSTICS changed_count=ROW_COUNT;
  IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_ATTEMPT_HEARTBEAT_INCONSISTENT'; END IF;
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION platform.heartbeat_model_image_effect_dispatch(TEXT,TEXT,BIGINT,INTEGER) FROM PUBLIC;

CREATE FUNCTION platform.load_model_image_effect_dispatch_secrets(
  requested_attempt_ref TEXT,requested_owner_ref TEXT,requested_fence BIGINT
) RETURNS TABLE(site_ref TEXT,logical_invocation_ref TEXT,operation_input_revision_ref TEXT,source_grants JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF length(requested_owner_ref) NOT BETWEEN 1 AND 128 OR requested_fence<1 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_DISPATCH_SECRET_FENCE_INVALID';
  END IF;
  RETURN QUERY SELECT invocation.site_ref,invocation.logical_invocation_ref,
    invocation.operation_input_revision_ref,invocation.source_grants
    FROM platform.model_image_effect_dispatch_queue queue
    JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=queue.attempt_ref
    JOIN platform.model_image_effect_invocation invocation
      ON invocation.logical_invocation_ref=attempt.logical_invocation_ref
   WHERE queue.attempt_ref=requested_attempt_ref AND queue.state='leased'
     AND queue.dispatch_owner_ref=requested_owner_ref AND queue.dispatch_fence=requested_fence
     AND queue.dispatch_lease_expires_at>statement_timestamp()
     AND attempt.dispatch_owner_ref=requested_owner_ref AND attempt.dispatch_fence=requested_fence
     AND attempt.dispatch_lease_expires_at>statement_timestamp();
END $$;
REVOKE ALL ON FUNCTION platform.load_model_image_effect_dispatch_secrets(TEXT,TEXT,BIGINT) FROM PUBLIC;

CREATE FUNCTION platform.guard_model_image_attempt_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF OLD.attempt_ref IS DISTINCT FROM NEW.attempt_ref
     OR OLD.logical_invocation_ref IS DISTINCT FROM NEW.logical_invocation_ref
     OR OLD.site_ref IS DISTINCT FROM NEW.site_ref
     OR OLD.attempt_ordinal IS DISTINCT FROM NEW.attempt_ordinal
     OR OLD.effect_budget_commit_ref IS DISTINCT FROM NEW.effect_budget_commit_ref
     OR OLD.effect_budget_commit_digest IS DISTINCT FROM NEW.effect_budget_commit_digest
     OR OLD.provider_operation_key IS DISTINCT FROM NEW.provider_operation_key THEN
    RAISE EXCEPTION 'MODEL_IMAGE_ATTEMPT_IMMUTABLE';
  END IF;
  IF NOT (
    (OLD.state='planned' AND NEW.state IN ('planned','definitely_not_submitted','submitted','submission_unknown'))
    OR (OLD.state='submitted' AND NEW.state IN ('submitted','running','succeeded','failed','canceled','outcome_unknown'))
    OR (OLD.state='submission_unknown' AND NEW.state IN ('submission_unknown','submitted','running','succeeded','failed','canceled','outcome_unknown'))
    OR (OLD.state='running' AND NEW.state IN ('running','succeeded','failed','canceled','outcome_unknown'))
    OR (OLD.state='outcome_unknown' AND NEW.state IN ('outcome_unknown','succeeded','failed','canceled'))
    OR (OLD.state=NEW.state AND OLD.state IN ('definitely_not_submitted','succeeded','failed','canceled'))
  ) THEN RAISE EXCEPTION 'MODEL_IMAGE_ATTEMPT_TRANSITION_INVALID'; END IF;
  IF NEW.dispatch_fence<OLD.dispatch_fence OR NEW.last_provider_sequence<OLD.last_provider_sequence THEN
    RAISE EXCEPTION 'MODEL_IMAGE_ATTEMPT_FENCE_REGRESSION';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_model_image_attempt_transition() FROM PUBLIC;
CREATE TRIGGER guard_model_image_attempt_transition
BEFORE UPDATE ON platform.model_image_effect_attempt
FOR EACH ROW EXECUTE FUNCTION platform.guard_model_image_attempt_transition();

CREATE FUNCTION platform.reject_model_image_owned_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_DELETE_FORBIDDEN'; END $$;
REVOKE ALL ON FUNCTION platform.reject_model_image_owned_delete() FROM PUBLIC;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'model_image_effect_access_authorization','model_image_source_grant_authorization',
    'model_image_option_authorization',
    'model_image_effect_budget_commit','model_image_effect_command_journal',
    'model_image_effect_invocation','model_image_effect_attempt',
    'model_image_effect_provider_observation','model_image_effect_output_evidence',
    'model_image_effect_dispatch_queue','model_image_effect_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY %I ON platform.%I TO platform_model_gateway '
      'USING (SESSION_USER=''platform_model_gateway'' AND site_ref=NULLIF(current_setting(''app.site_id'',true),'''')) '
      'WITH CHECK (SESSION_USER=''platform_model_gateway'' AND site_ref=NULLIF(current_setting(''app.site_id'',true),''''))',
      table_name||'_runtime_site_scope',table_name);
    EXECUTE format('CREATE POLICY %I ON platform.%I TO platform_migrator '
      'USING (SESSION_USER=''platform_model_gateway'') WITH CHECK (SESSION_USER=''platform_model_gateway'')',
      table_name||'_runtime_definer',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON platform.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_model_image_owned_delete()',
      table_name||'_no_delete',table_name);
  END LOOP;
END $$;

CREATE POLICY model_image_effect_invocation_worker_definer
  ON platform.model_image_effect_invocation TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');
CREATE POLICY model_image_effect_attempt_worker_definer
  ON platform.model_image_effect_attempt TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');
CREATE POLICY model_image_effect_observation_worker_definer
  ON platform.model_image_effect_provider_observation TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');
CREATE POLICY model_image_effect_output_worker_definer
  ON platform.model_image_effect_output_evidence TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');
CREATE POLICY model_image_effect_queue_worker_definer
  ON platform.model_image_effect_dispatch_queue TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');
CREATE POLICY model_image_effect_outbox_worker_definer
  ON platform.model_image_effect_outbox TO platform_migrator
  USING (SESSION_USER='platform_model_image_worker')
  WITH CHECK (SESSION_USER='platform_model_image_worker');

REVOKE ALL ON TABLE
  platform.model_image_effect_access_authorization,platform.model_image_source_grant_authorization,
  platform.model_image_option_authorization,
  platform.model_image_effect_budget_commit,platform.model_image_effect_command_journal,
  platform.model_image_effect_invocation,platform.model_image_effect_attempt,
  platform.model_image_effect_provider_observation,platform.model_image_effect_output_evidence,
  platform.model_image_effect_dispatch_queue,platform.model_image_effect_outbox
FROM PUBLIC;

GRANT SELECT,INSERT ON platform.model_image_effect_command_journal TO platform_model_gateway;
GRANT SELECT,INSERT ON platform.model_image_effect_invocation TO platform_model_gateway;
GRANT UPDATE(owner_version,state,current_attempt_ordinal,updated_at)
  ON platform.model_image_effect_invocation TO platform_model_gateway;
GRANT SELECT,INSERT ON platform.model_image_effect_attempt TO platform_model_gateway;
GRANT UPDATE(cancel_requested,updated_at) ON platform.model_image_effect_attempt TO platform_model_gateway;
GRANT SELECT ON platform.model_image_effect_provider_observation,
  platform.model_image_effect_output_evidence TO platform_model_gateway;
GRANT INSERT ON platform.model_image_effect_dispatch_queue,platform.model_image_effect_outbox
  TO platform_model_gateway;
GRANT USAGE,SELECT ON SEQUENCE platform.model_image_effect_command_journal_command_journal_id_seq
  TO platform_model_gateway;

GRANT EXECUTE ON FUNCTION platform.resolve_model_image_effect_access(TEXT,TEXT),
  platform.resolve_model_image_source_grant_authorizations(TEXT,TEXT[],TEXT[]),
  platform.resolve_model_image_option_authorization(TEXT,TEXT),
  platform.consume_model_image_effect_budget_commit(
    TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
  TO platform_model_gateway;
GRANT EXECUTE ON FUNCTION platform.claim_model_image_effect_dispatch(TEXT,INTEGER),
  platform.heartbeat_model_image_effect_dispatch(TEXT,TEXT,BIGINT,INTEGER),
  platform.load_model_image_effect_dispatch_secrets(TEXT,TEXT,BIGINT)
  TO platform_model_image_worker;

REVOKE CREATE ON SCHEMA platform FROM platform_model_gateway,platform_model_image_worker;
