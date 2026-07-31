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
  attempt_authorization_ref UUID NOT NULL UNIQUE REFERENCES platform.credit_usage_attempt_intent(attempt_authorization_ref),
  attempt_authorization_fence_epoch BIGINT NOT NULL CHECK (attempt_authorization_fence_epoch>0),
  attempt_authorization_digest CHAR(64) NOT NULL CHECK (attempt_authorization_digest ~ '^[0-9a-f]{64}$'),
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
  UNIQUE (effect_budget_commit_ref,effect_budget_commit_digest,attempt_authorization_ref,
    attempt_authorization_fence_epoch,attempt_authorization_digest),
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
  last_evidence_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_evidence_sequence>=0),
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
  attempt_authorization_ref UUID NOT NULL UNIQUE,
  attempt_authorization_fence_epoch BIGINT NOT NULL CHECK (attempt_authorization_fence_epoch>0),
  attempt_authorization_digest CHAR(64) NOT NULL CHECK (attempt_authorization_digest ~ '^[0-9a-f]{64}$'),
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
  FOREIGN KEY (effect_budget_commit_ref,effect_budget_commit_digest,attempt_authorization_ref,
    attempt_authorization_fence_epoch,attempt_authorization_digest) REFERENCES
    platform.model_image_effect_budget_commit(effect_budget_commit_ref,effect_budget_commit_digest,
      attempt_authorization_ref,attempt_authorization_fence_epoch,attempt_authorization_digest),
  FOREIGN KEY (attempt_authorization_ref) REFERENCES
    platform.credit_usage_attempt_intent(attempt_authorization_ref),
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
  candidate_ordinal INTEGER NOT NULL CHECK (candidate_ordinal BETWEEN 1 AND 4),
  candidate_ref TEXT NOT NULL CHECK (length(candidate_ref) BETWEEN 1 AND 256),
  stable_output_slot_ref TEXT NOT NULL CHECK (length(stable_output_slot_ref) BETWEEN 1 AND 256),
  output_evidence_ref TEXT NOT NULL CHECK (length(output_evidence_ref) BETWEEN 1 AND 256),
  output_evidence_digest TEXT NOT NULL CHECK (output_evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_output_fact_ref TEXT NOT NULL CHECK (length(provider_output_fact_ref) BETWEEN 1 AND 256),
  retrieval_grant_handle_digest TEXT NOT NULL CHECK (retrieval_grant_handle_digest ~ '^[0-9a-f]{64}$'),
  retrieval_grant_envelope JSONB NOT NULL CHECK (jsonb_typeof(retrieval_grant_envelope)='object'),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp')),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 65535),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 65535),
  declared_byte_size BIGINT CHECK (declared_byte_size>0),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (output_evidence_ref,output_evidence_digest),
  UNIQUE (attempt_ref,candidate_ordinal),
  UNIQUE (attempt_ref,candidate_ref),
  UNIQUE (attempt_ref,stable_output_slot_ref),
  UNIQUE (attempt_ref,provider_output_fact_ref)
);

CREATE TABLE platform.model_image_effect_evidence_ledger (
  evidence_ledger_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  attempt_ref TEXT NOT NULL REFERENCES platform.model_image_effect_attempt(attempt_ref),
  evidence_sequence BIGINT NOT NULL CHECK (evidence_sequence>0),
  owner_version BIGINT NOT NULL CHECK (owner_version>0),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('outcome','usage','output')),
  evidence_ref TEXT NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  usage_fact JSONB,
  candidate_ordinal INTEGER,
  candidate_ref TEXT,
  stable_output_slot_ref TEXT,
  output_evidence_ref TEXT,
  output_evidence_digest TEXT CHECK (
    output_evidence_digest IS NULL OR output_evidence_digest ~ '^[0-9a-f]{64}$'),
  provider_output_fact_ref TEXT,
  retrieval_grant_handle_digest TEXT CHECK (
    retrieval_grant_handle_digest IS NULL OR retrieval_grant_handle_digest ~ '^[0-9a-f]{64}$'),
  media_type TEXT CHECK (media_type IS NULL OR media_type IN ('image/png','image/jpeg','image/webp')),
  width INTEGER,
  height INTEGER,
  declared_byte_size BIGINT,
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (logical_invocation_ref,evidence_sequence),
  UNIQUE (logical_invocation_ref,evidence_ref,evidence_digest),
  CHECK ((evidence_kind='output') = (candidate_ordinal IS NOT NULL)),
  CHECK ((evidence_kind='usage') = (usage_fact IS NOT NULL)),
  CHECK (usage_fact IS NULL OR
    CASE WHEN jsonb_typeof(usage_fact)='object' THEN
      COALESCE(usage_fact->>'evidenceKind','') IN ('measured','zero','unavailable') AND
      COALESCE(usage_fact->>'attemptOutcome','') IN
        ('succeeded','failed_after_effect','canceled_after_effect') AND
      COALESCE(usage_fact->>'sourceDigest','') ~ '^[a-f0-9]{64}$' AND
      CASE WHEN jsonb_typeof(usage_fact->'dimensions')='array'
        THEN jsonb_array_length(usage_fact->'dimensions')<=64 ELSE FALSE END
    ELSE FALSE END),
  CHECK ((evidence_kind='output') = (candidate_ref IS NOT NULL)),
  CHECK ((evidence_kind='output') = (stable_output_slot_ref IS NOT NULL)),
  CHECK ((evidence_kind='output') = (output_evidence_ref IS NOT NULL)),
  CHECK ((evidence_kind='output') = (output_evidence_digest IS NOT NULL)),
  CHECK ((evidence_kind='output') = (provider_output_fact_ref IS NOT NULL)),
  CHECK ((evidence_kind='output') = (retrieval_grant_handle_digest IS NOT NULL)),
  CHECK ((evidence_kind='output') = (media_type IS NOT NULL)),
  CHECK ((evidence_kind='output') = (width IS NOT NULL)),
  CHECK ((evidence_kind='output') = (height IS NOT NULL)),
  CHECK (candidate_ordinal IS NULL OR candidate_ordinal BETWEEN 1 AND 4),
  CHECK (width IS NULL OR width BETWEEN 1 AND 65535),
  CHECK (height IS NULL OR height BETWEEN 1 AND 65535),
  CHECK (declared_byte_size IS NULL OR declared_byte_size>0)
);

CREATE INDEX model_image_effect_evidence_page_idx
  ON platform.model_image_effect_evidence_ledger(logical_invocation_ref,evidence_sequence);

CREATE TABLE platform.model_image_effect_output_access (
  output_access_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_ref TEXT NOT NULL CHECK (length(site_ref) BETWEEN 1 AND 256),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  caller_access_handle_digest TEXT NOT NULL CHECK (caller_access_handle_digest ~ '^[0-9a-f]{64}$'),
  output_access_command_ref TEXT NOT NULL CHECK (length(output_access_command_ref) BETWEEN 1 AND 256),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  logical_invocation_ref TEXT NOT NULL REFERENCES
    platform.model_image_effect_invocation(logical_invocation_ref),
  output_evidence_ref TEXT NOT NULL,
  output_evidence_digest TEXT NOT NULL CHECK (output_evidence_digest ~ '^[0-9a-f]{64}$'),
  attempt_ref TEXT NOT NULL REFERENCES platform.model_image_effect_attempt(attempt_ref),
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal BETWEEN 1 AND 64),
  capability_ref TEXT NOT NULL UNIQUE CHECK (length(capability_ref) BETWEEN 1 AND 256),
  audience TEXT NOT NULL CHECK (audience='platform-media-worker'),
  max_readable_bytes BIGINT NOT NULL CHECK (max_readable_bytes>0),
  expires_at TIMESTAMPTZ NOT NULL,
  security_epoch BIGINT NOT NULL CHECK (security_epoch>0),
  source_access_handle_digest TEXT NOT NULL UNIQUE CHECK (source_access_handle_digest ~ '^[0-9a-f]{64}$'),
  recovery_envelope JSONB NOT NULL CHECK (jsonb_typeof(recovery_envelope)='object'),
  receipt_version BIGINT NOT NULL CHECK (receipt_version>0),
  recorded_at TIMESTAMPTZ NOT NULL,
  receipt_ref TEXT NOT NULL UNIQUE CHECK (receipt_ref ~ '^image-effect-receipt:sha256:[0-9a-f]{64}$'),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  UNIQUE (caller_identity,output_access_command_ref),
  FOREIGN KEY (output_evidence_ref,output_evidence_digest) REFERENCES
    platform.model_image_effect_output_evidence(output_evidence_ref,output_evidence_digest)
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

CREATE FUNCTION platform.authorize_model_image_effect_output_read(
  requested_handle_digest TEXT,requested_capability_ref TEXT,requested_site_ref TEXT,
  requested_caller_identity TEXT,requested_output_ref TEXT,requested_output_digest TEXT,
  requested_security_epoch BIGINT,requested_now TIMESTAMPTZ
) RETURNS TABLE(attempt_ref TEXT,attempt_ordinal INTEGER,logical_invocation_ref TEXT,
  output_evidence_ref TEXT,output_evidence_digest TEXT,declared_byte_size BIGINT,provider_output_fact_ref TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('runtime');
  IF requested_now NOT BETWEEN statement_timestamp()-INTERVAL '5 minutes'
    AND statement_timestamp()+INTERVAL '5 minutes' THEN RETURN; END IF;
  RETURN QUERY SELECT output.attempt_ref,attempt.attempt_ordinal,attempt.logical_invocation_ref,
    output.output_evidence_ref,output.output_evidence_digest,output.declared_byte_size,
    output.provider_output_fact_ref
  FROM platform.model_image_effect_output_access access
  JOIN platform.model_image_effect_access_authorization caller
    ON caller.caller_access_handle_digest=access.caller_access_handle_digest
  JOIN platform.model_image_effect_output_evidence output
    ON output.output_evidence_ref=access.output_evidence_ref
   AND output.output_evidence_digest=access.output_evidence_digest
  JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=output.attempt_ref
  WHERE access.source_access_handle_digest=requested_handle_digest
    AND access.capability_ref=requested_capability_ref AND access.site_ref=requested_site_ref
    AND access.caller_identity=requested_caller_identity
    AND access.output_evidence_ref=requested_output_ref
    AND access.output_evidence_digest=requested_output_digest
    AND access.security_epoch=requested_security_epoch
    AND access.expires_at>statement_timestamp()
    AND caller.state='active' AND caller.security_epoch=requested_security_epoch
    AND caller.expires_at>statement_timestamp();
END $$;
REVOKE ALL ON FUNCTION platform.authorize_model_image_effect_output_read(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TIMESTAMPTZ) FROM PUBLIC;

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
  attempt_authorization_ref UUID,
  attempt_authorization_fence_epoch BIGINT,
  attempt_authorization_digest CHAR(64),
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
      budget.attempt_authorization_ref,budget.attempt_authorization_fence_epoch,
      budget.attempt_authorization_digest,
      budget.expires_at,FALSE FROM platform.model_image_effect_budget_commit budget
      WHERE budget.effect_budget_commit_ref=requested_commit_ref;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT budget.effect_budget_commit_ref,budget.effect_budget_commit_digest,budget.attempt_ordinal,
           budget.attempt_authorization_ref,budget.attempt_authorization_fence_epoch,
           budget.attempt_authorization_digest,budget.expires_at,TRUE
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
) RETURNS TABLE (site_ref TEXT,attempt_ref TEXT,logical_invocation_ref TEXT,dispatch_fence BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE selected_site_ref TEXT; selected_attempt_ref TEXT; selected_invocation_ref TEXT; next_fence BIGINT;
  lease_until TIMESTAMPTZ; changed_count INTEGER;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF length(requested_owner_ref) NOT BETWEEN 1 AND 128 OR
     requested_lease_milliseconds NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_DISPATCH_LEASE_INVALID';
  END IF;
  SELECT queue.site_ref,queue.attempt_ref,queue.logical_invocation_ref,queue.dispatch_fence+1
    INTO selected_site_ref,selected_attempt_ref,selected_invocation_ref,next_fence
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
  RETURN QUERY SELECT selected_site_ref,selected_attempt_ref,selected_invocation_ref,next_fence;
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

CREATE FUNCTION platform.load_model_image_effect_dispatch_context(
  requested_attempt_ref TEXT,requested_owner_ref TEXT,requested_fence BIGINT
) RETURNS TABLE(context JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  RETURN QUERY
  SELECT jsonb_build_object(
    'siteId',invocation.site_ref,
    'logicalInvocationRef',invocation.logical_invocation_ref,
    'definitionRoleRef',invocation.definition_role_ref,
    'modelOptionRevisionRef',invocation.model_option_revision_ref,
    'deploymentRef',invocation.deployment_ref,
    'adapterKind',invocation.adapter_kind,
    'providerModel',invocation.provider_model,
    'operationInputRevisionRef',invocation.operation_input_revision_ref,
    'operationInputRevisionDigest',invocation.operation_input_revision_digest,
    'sourceGrantRefs',invocation.source_grant_refs,
    'logicalOutputSlots',invocation.logical_output_slots,
    'attempt',jsonb_build_object(
      'attemptRef',attempt.attempt_ref,
      'ordinal',attempt.attempt_ordinal,
      'budgetCommitRef',attempt.effect_budget_commit_ref,
      'budgetCommitDigest',attempt.effect_budget_commit_digest,
      'attemptAuthorizationRef',attempt.attempt_authorization_ref,
      'attemptAuthorizationFenceEpoch',attempt.attempt_authorization_fence_epoch::TEXT,
      'attemptAuthorizationDigest',attempt.attempt_authorization_digest,
      'providerOperationKey',attempt.provider_operation_key,
      'state',attempt.state,
      'cancelRequested',attempt.cancel_requested,
      'lastProviderSequence',attempt.last_provider_sequence::TEXT,
      'providerOperationRef',attempt.provider_operation_ref,
      'definitelyNotSubmittedReceiptRef',attempt.definitely_not_submitted_receipt_ref,
      'definitelyNotSubmittedReceiptDigest',attempt.definitely_not_submitted_receipt_digest,
      'canonicalOutcomeEvidenceRef',attempt.canonical_outcome_evidence_ref,
      'canonicalOutcomeEvidenceDigest',attempt.canonical_outcome_evidence_digest,
      'usageEvidenceRef',attempt.usage_evidence_ref,
      'usageEvidenceDigest',attempt.usage_evidence_digest,
      'lateOutcome',attempt.late_outcome,
      'observations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'eventRef',observation.provider_event_ref,'sequence',observation.provider_sequence::TEXT,
        'digest',observation.observation_digest) ORDER BY observation.provider_sequence)
        FROM platform.model_image_effect_provider_observation observation
        WHERE observation.attempt_ref=attempt.attempt_ref),'[]'::JSONB),
      'outputs',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'candidateRef',output.candidate_ref,'stableOutputSlotRef',output.stable_output_slot_ref,
        'providerOutputFactRef',output.provider_output_fact_ref,
        'retrievalGrantHandleDigest',output.retrieval_grant_handle_digest) ORDER BY output.candidate_ordinal)
        FROM platform.model_image_effect_output_evidence output
        WHERE output.attempt_ref=attempt.attempt_ref),'[]'::JSONB)
    ))
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
REVOKE ALL ON FUNCTION platform.load_model_image_effect_dispatch_context(TEXT,TEXT,BIGINT) FROM PUBLIC;

CREATE FUNCTION platform.record_model_image_effect_observation(
  requested_attempt_ref TEXT,requested_invocation_ref TEXT,requested_owner_ref TEXT,requested_fence BIGINT,
  requested_event_ref TEXT,requested_sequence BIGINT,requested_kind TEXT,requested_digest TEXT,
  requested_observed_at TIMESTAMPTZ,requested_attempt JSONB,requested_outputs JSONB,requested_evidence JSONB,
  requested_outbox_ref TEXT,requested_outbox_payload JSONB,requested_outbox_digest TEXT
) RETURNS TABLE(persisted BOOLEAN,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owned_attempt platform.model_image_effect_attempt%ROWTYPE;
  owned_invocation platform.model_image_effect_invocation%ROWTYPE;
  prior_observation platform.model_image_effect_provider_observation%ROWTYPE;
  next_owner_version BIGINT; next_evidence_sequence BIGINT; evidence_count INTEGER;
  usage_count INTEGER;
  next_attempt_state TEXT; next_invocation_state TEXT; terminal BOOLEAN;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF jsonb_typeof(requested_attempt)<>'object' OR jsonb_typeof(requested_outputs)<>'array'
     OR jsonb_typeof(requested_evidence)<>'array' OR jsonb_typeof(requested_outbox_payload)<>'object'
     OR requested_sequence<1 OR requested_fence<1
     OR requested_kind NOT IN ('definitely_not_submitted','submitted','submission_unknown','running',
       'succeeded','failed','canceled','outcome_unknown')
     OR requested_digest !~ '^[0-9a-f]{64}$' OR requested_outbox_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_OBSERVATION_REQUEST_INVALID';
  END IF;
  SELECT attempt.* INTO owned_attempt
  FROM platform.model_image_effect_dispatch_queue queue
  JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=queue.attempt_ref
  WHERE queue.attempt_ref=requested_attempt_ref AND queue.logical_invocation_ref=requested_invocation_ref
    AND queue.state='leased' AND queue.dispatch_owner_ref=requested_owner_ref
    AND queue.dispatch_fence=requested_fence AND queue.dispatch_lease_expires_at>statement_timestamp()
    AND attempt.dispatch_owner_ref=requested_owner_ref AND attempt.dispatch_fence=requested_fence
    AND attempt.dispatch_lease_expires_at>statement_timestamp()
  FOR UPDATE OF queue,attempt;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT invocation.* INTO STRICT owned_invocation
    FROM platform.model_image_effect_invocation invocation
   WHERE invocation.logical_invocation_ref=requested_invocation_ref FOR UPDATE;

  SELECT observation.* INTO prior_observation
    FROM platform.model_image_effect_provider_observation observation
   WHERE observation.attempt_ref=requested_attempt_ref
     AND (observation.provider_event_ref=requested_event_ref OR observation.provider_sequence=requested_sequence)
   FOR UPDATE;
  IF FOUND THEN
    IF prior_observation.provider_event_ref<>requested_event_ref
       OR prior_observation.provider_sequence<>requested_sequence
       OR prior_observation.observation_kind<>requested_kind
       OR prior_observation.observation_digest<>requested_digest THEN
      RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_PROVIDER_EVENT_CONFLICT';
    END IF;
    RETURN QUERY SELECT TRUE,TRUE;
    RETURN;
  END IF;
  IF requested_sequence<>owned_attempt.last_provider_sequence+1
     OR requested_attempt->>'attemptRef'<>requested_attempt_ref
     OR (requested_attempt->>'lastProviderSequence')::BIGINT<>requested_sequence
     OR requested_attempt->>'state'<>requested_kind THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_PROVIDER_SEQUENCE_CONFLICT';
  END IF;
  next_attempt_state:=requested_attempt->>'state';
  terminal:=next_attempt_state IN ('definitely_not_submitted','succeeded','failed','canceled','outcome_unknown');
  evidence_count:=jsonb_array_length(requested_evidence);
  IF (next_attempt_state IN ('succeeded','failed','canceled','outcome_unknown'))<>(evidence_count>0)
     OR (next_attempt_state='succeeded')<>(jsonb_array_length(requested_outputs)>0)
     OR jsonb_array_length(requested_outputs)>4 OR evidence_count>6 THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_EVIDENCE_SET_INVALID';
  END IF;
  SELECT count(*)::INTEGER INTO usage_count
    FROM jsonb_array_elements(requested_evidence) evidence(value)
   WHERE evidence.value->>'kind'='usage';
  IF usage_count>1 OR
     (requested_kind='succeeded' AND usage_count<>1) OR
     (requested_kind='outcome_unknown' AND usage_count<>0) OR
     ((requested_attempt->>'usageEvidenceRef' IS NULL)<>
       (requested_attempt->>'usageEvidenceDigest' IS NULL)) OR
     ((usage_count=1)<>
       (requested_attempt->>'usageEvidenceRef' IS NOT NULL AND
        requested_attempt->>'usageEvidenceDigest' IS NOT NULL)) OR
     (usage_count=1 AND NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements(requested_evidence) evidence(value)
        WHERE evidence.value->>'kind'='usage'
          AND requested_attempt->>'usageEvidenceRef'=evidence.value->>'evidenceRef'
          AND requested_attempt->>'usageEvidenceDigest'=evidence.value->>'evidenceDigest'
     )) THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_USAGE_FACT_INVALID'; END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(requested_evidence) evidence(value)
     WHERE evidence.value->>'kind'='usage' AND
       (jsonb_typeof(evidence.value->'usageFact') IS DISTINCT FROM 'object' OR
        COALESCE(evidence.value#>>'{usageFact,evidenceKind}','') NOT IN
          ('measured','zero','unavailable') OR
        COALESCE(evidence.value#>>'{usageFact,attemptOutcome}','')<>
          CASE requested_kind WHEN 'succeeded' THEN 'succeeded'
            WHEN 'failed' THEN 'failed_after_effect'
            WHEN 'canceled' THEN 'canceled_after_effect' ELSE '__invalid__' END OR
        COALESCE(evidence.value#>>'{usageFact,sourceDigest}','') !~ '^[a-f0-9]{64}$' OR
        jsonb_typeof(evidence.value#>'{usageFact,occurredAt}') IS DISTINCT FROM 'string' OR
        length(evidence.value#>>'{usageFact,occurredAt}') NOT BETWEEN 1 AND 64 OR
        jsonb_typeof(evidence.value#>'{usageFact,dimensions}') IS DISTINCT FROM 'array' OR
        ((evidence.value#>>'{usageFact,evidenceKind}')='unavailable' AND
          COALESCE(evidence.value#>>'{usageFact,unavailableReasonCode}','') !~ '^[A-Z0-9_]{1,128}$') OR
        ((evidence.value#>>'{usageFact,evidenceKind}')<>'unavailable' AND
          (evidence.value->'usageFact') ? 'unavailableReasonCode'))
  ) THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_USAGE_FACT_INVALID'; END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(requested_evidence) evidence(value)
     WHERE evidence.value->>'kind'='usage' AND
       (jsonb_array_length(evidence.value#>'{usageFact,dimensions}')>64 OR
        ((evidence.value#>>'{usageFact,evidenceKind}')='measured')<>
          (jsonb_array_length(evidence.value#>'{usageFact,dimensions}')>0) OR
        (SELECT count(*)<>count(DISTINCT dimension.value->>'dimensionKey')
           FROM jsonb_array_elements(evidence.value#>'{usageFact,dimensions}') AS dimension(value)) OR
        EXISTS(SELECT 1 FROM jsonb_array_elements(evidence.value#>'{usageFact,dimensions}') AS dimension(value)
          WHERE COALESCE(dimension.value->>'dimensionKey','') !~
                  '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' OR
            COALESCE(dimension.value->>'sourceUnit','') !~
                  '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$' OR
            COALESCE(dimension.value->>'quantity','') !~ '^(0|[1-9][0-9]{0,37})$'))
  ) THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_USAGE_FACT_INVALID'; END IF;

  INSERT INTO platform.model_image_effect_provider_observation
    (site_ref,attempt_ref,provider_event_ref,provider_sequence,observation_kind,observation_digest,observed_at)
  VALUES (owned_attempt.site_ref,requested_attempt_ref,requested_event_ref,requested_sequence,
    requested_kind,requested_digest,requested_observed_at);

  INSERT INTO platform.model_image_effect_output_evidence
    (site_ref,attempt_ref,candidate_ordinal,candidate_ref,stable_output_slot_ref,output_evidence_ref,
     output_evidence_digest,provider_output_fact_ref,retrieval_grant_handle_digest,retrieval_grant_envelope,
     media_type,width,height,declared_byte_size,recorded_at)
  SELECT owned_attempt.site_ref,requested_attempt_ref,output."candidateOrdinal",output."candidateRef",
    output."stableOutputSlotRef",output."outputEvidenceRef",output."outputEvidenceDigest",
    output."providerOutputFactRef",output."retrievalGrantHandleDigest",output."retrievalGrantEnvelope",
    output."mediaType",output.width,output.height,output."declaredByteSize",requested_observed_at
  FROM jsonb_to_recordset(requested_outputs) AS output(
    "candidateOrdinal" INTEGER,"candidateRef" TEXT,"stableOutputSlotRef" TEXT,
    "outputEvidenceRef" TEXT,"outputEvidenceDigest" TEXT,"providerOutputFactRef" TEXT,
    "retrievalGrantHandleDigest" TEXT,"retrievalGrantEnvelope" JSONB,"mediaType" TEXT,
    width INTEGER,height INTEGER,"declaredByteSize" BIGINT);

  UPDATE platform.model_image_effect_attempt attempt SET
    state=next_attempt_state,
    cancel_requested=(requested_attempt->>'cancelRequested')::BOOLEAN,
    last_provider_sequence=requested_sequence,
    provider_operation_ref=requested_attempt->>'providerOperationRef',
    definitely_not_submitted_receipt_ref=requested_attempt->>'definitelyNotSubmittedReceiptRef',
    definitely_not_submitted_receipt_digest=requested_attempt->>'definitelyNotSubmittedReceiptDigest',
    canonical_outcome_evidence_ref=requested_attempt->>'canonicalOutcomeEvidenceRef',
    canonical_outcome_evidence_digest=requested_attempt->>'canonicalOutcomeEvidenceDigest',
    usage_evidence_ref=requested_attempt->>'usageEvidenceRef',
    usage_evidence_digest=requested_attempt->>'usageEvidenceDigest',
    late_outcome=(requested_attempt->>'lateOutcome')::BOOLEAN,
    updated_at=requested_observed_at
  WHERE attempt.attempt_ref=requested_attempt_ref;

  next_owner_version:=owned_invocation.owner_version+1;
  next_evidence_sequence:=owned_invocation.last_evidence_sequence;
  INSERT INTO platform.model_image_effect_evidence_ledger
    (site_ref,logical_invocation_ref,attempt_ref,evidence_sequence,owner_version,evidence_kind,
     evidence_ref,evidence_digest,usage_fact,candidate_ordinal,candidate_ref,stable_output_slot_ref,
     output_evidence_ref,output_evidence_digest,provider_output_fact_ref,retrieval_grant_handle_digest,
     media_type,width,height,declared_byte_size,recorded_at)
  SELECT owned_invocation.site_ref,requested_invocation_ref,requested_attempt_ref,
    next_evidence_sequence+evidence.ordinality,next_owner_version,evidence.value->>'kind',
    evidence.value->>'evidenceRef',evidence.value->>'evidenceDigest',evidence.value->'usageFact',
    (evidence.value->'output'->>'candidateOrdinal')::INTEGER,evidence.value->'output'->>'candidateRef',
    evidence.value->'output'->>'stableOutputSlotRef',evidence.value->'output'->>'outputEvidenceRef',
    evidence.value->'output'->>'outputEvidenceDigest',evidence.value->'output'->>'providerOutputFactRef',
    evidence.value->'output'->>'retrievalGrantHandleDigest',evidence.value->'output'->>'mediaType',
    (evidence.value->'output'->>'width')::INTEGER,(evidence.value->'output'->>'height')::INTEGER,
    (evidence.value->'output'->>'declaredByteSize')::BIGINT,requested_observed_at
  FROM jsonb_array_elements(requested_evidence) WITH ORDINALITY evidence(value,ordinality);

  next_invocation_state:=CASE
    WHEN owned_invocation.state='cancel_requested' AND NOT terminal THEN 'cancel_requested'
    WHEN next_attempt_state='planned' THEN 'accepted' ELSE next_attempt_state END;
  UPDATE platform.model_image_effect_invocation invocation SET
    owner_version=next_owner_version,
    last_evidence_sequence=next_evidence_sequence+evidence_count,
    state=next_invocation_state,
    updated_at=requested_observed_at
  WHERE invocation.logical_invocation_ref=requested_invocation_ref
    AND invocation.owner_version=owned_invocation.owner_version;

  UPDATE platform.model_image_effect_dispatch_queue queue SET
    state=CASE WHEN terminal THEN 'terminal' ELSE 'leased' END,
    dispatch_owner_ref=CASE WHEN terminal THEN NULL ELSE requested_owner_ref END,
    dispatch_lease_expires_at=CASE WHEN terminal THEN NULL ELSE queue.dispatch_lease_expires_at END,
    updated_at=requested_observed_at
  WHERE queue.attempt_ref=requested_attempt_ref;

  INSERT INTO platform.model_image_effect_outbox
    (event_ref,site_ref,logical_invocation_ref,event_kind,evidence_revision,payload,payload_digest,created_at)
  VALUES (requested_outbox_ref,owned_invocation.site_ref,requested_invocation_ref,
    'image_effect.observed.v1',next_owner_version,requested_outbox_payload,requested_outbox_digest,
    requested_observed_at);
  RETURN QUERY SELECT TRUE,FALSE;
END $$;
REVOKE ALL ON FUNCTION platform.record_model_image_effect_observation(
  TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,JSONB,JSONB,JSONB,TEXT,JSONB,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.dead_letter_model_image_effect_before_provider_io(
  requested_attempt_ref TEXT,requested_owner_ref TEXT,requested_fence BIGINT,requested_error_code TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE changed_count INTEGER;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  UPDATE platform.model_image_effect_dispatch_queue queue SET state='dead_letter',
    dispatch_owner_ref=NULL,dispatch_lease_expires_at=NULL,last_error_code=requested_error_code,
    updated_at=statement_timestamp()
  FROM platform.model_image_effect_attempt attempt
  WHERE queue.attempt_ref=requested_attempt_ref AND attempt.attempt_ref=queue.attempt_ref
    AND queue.state='leased' AND queue.dispatch_owner_ref=requested_owner_ref
    AND queue.dispatch_fence=requested_fence AND queue.dispatch_lease_expires_at>statement_timestamp()
    AND attempt.state='planned' AND attempt.last_provider_sequence=0
    AND attempt.dispatch_owner_ref=requested_owner_ref AND attempt.dispatch_fence=requested_fence;
  GET DIAGNOSTICS changed_count=ROW_COUNT;
  RETURN changed_count=1;
END $$;
REVOKE ALL ON FUNCTION platform.dead_letter_model_image_effect_before_provider_io(TEXT,TEXT,BIGINT,TEXT)
  FROM PUBLIC;

CREATE FUNCTION platform.return_model_image_effect_dispatch_leases(
  requested_owner_ref TEXT,requested_error_code TEXT
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owned RECORD; returned_count INTEGER:=0; changed_count INTEGER;
BEGIN
  PERFORM platform.assert_model_image_effect_runtime_role('worker');
  IF length(requested_owner_ref) NOT BETWEEN 1 AND 128
     OR requested_error_code !~ '^[A-Z0-9_]{1,128}$' THEN
    RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_LEASE_RETURN_INVALID';
  END IF;
  FOR owned IN
    SELECT queue.attempt_ref,queue.dispatch_fence
      FROM platform.model_image_effect_dispatch_queue queue
      JOIN platform.model_image_effect_attempt attempt ON attempt.attempt_ref=queue.attempt_ref
     WHERE queue.state='leased' AND queue.dispatch_owner_ref=requested_owner_ref
       AND attempt.dispatch_owner_ref=requested_owner_ref
       AND attempt.dispatch_fence=queue.dispatch_fence
     ORDER BY queue.attempt_ref FOR UPDATE OF queue,attempt
  LOOP
    UPDATE platform.model_image_effect_dispatch_queue queue
       SET state='queued',available_at=statement_timestamp(),dispatch_owner_ref=NULL,
           dispatch_lease_expires_at=NULL,last_error_code=requested_error_code,
           updated_at=statement_timestamp()
     WHERE queue.attempt_ref=owned.attempt_ref AND queue.state='leased'
       AND queue.dispatch_owner_ref=requested_owner_ref AND queue.dispatch_fence=owned.dispatch_fence;
    GET DIAGNOSTICS changed_count=ROW_COUNT;
    IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_QUEUE_LEASE_RETURN_INCONSISTENT'; END IF;
    UPDATE platform.model_image_effect_attempt attempt
       SET dispatch_owner_ref=NULL,dispatch_lease_expires_at=NULL,heartbeat_at=statement_timestamp(),
           updated_at=statement_timestamp()
     WHERE attempt.attempt_ref=owned.attempt_ref AND attempt.dispatch_owner_ref=requested_owner_ref
       AND attempt.dispatch_fence=owned.dispatch_fence;
    GET DIAGNOSTICS changed_count=ROW_COUNT;
    IF changed_count<>1 THEN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_ATTEMPT_LEASE_RETURN_INCONSISTENT'; END IF;
    returned_count:=returned_count+1;
  END LOOP;
  RETURN returned_count;
END $$;
REVOKE ALL ON FUNCTION platform.return_model_image_effect_dispatch_leases(TEXT,TEXT) FROM PUBLIC;

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

CREATE FUNCTION platform.guard_model_image_effect_evidence_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN RAISE EXCEPTION 'MODEL_IMAGE_EFFECT_EVIDENCE_APPEND_ONLY'; END $$;
REVOKE ALL ON FUNCTION platform.guard_model_image_effect_evidence_append_only() FROM PUBLIC;
CREATE TRIGGER guard_model_image_effect_evidence_append_only
BEFORE UPDATE OR DELETE ON platform.model_image_effect_evidence_ledger
FOR EACH ROW EXECUTE FUNCTION platform.guard_model_image_effect_evidence_append_only();

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
    'model_image_effect_evidence_ledger','model_image_effect_output_access',
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
CREATE POLICY model_image_effect_evidence_worker_definer
  ON platform.model_image_effect_evidence_ledger TO platform_migrator
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
  platform.model_image_effect_evidence_ledger,platform.model_image_effect_output_access,
  platform.model_image_effect_dispatch_queue,platform.model_image_effect_outbox
FROM PUBLIC;

GRANT SELECT,INSERT ON platform.model_image_effect_command_journal TO platform_model_gateway;
GRANT SELECT,INSERT ON platform.model_image_effect_invocation TO platform_model_gateway;
GRANT UPDATE(owner_version,last_evidence_sequence,state,current_attempt_ordinal,updated_at)
  ON platform.model_image_effect_invocation TO platform_model_gateway;
GRANT SELECT,INSERT ON platform.model_image_effect_attempt TO platform_model_gateway;
GRANT UPDATE(cancel_requested,updated_at) ON platform.model_image_effect_attempt TO platform_model_gateway;
GRANT SELECT ON platform.model_image_effect_provider_observation,
  platform.model_image_effect_output_evidence,platform.model_image_effect_evidence_ledger
  TO platform_model_gateway;
GRANT SELECT,INSERT ON platform.model_image_effect_output_access TO platform_model_gateway;
GRANT INSERT ON platform.model_image_effect_dispatch_queue,platform.model_image_effect_outbox
  TO platform_model_gateway;
GRANT USAGE,SELECT ON SEQUENCE platform.model_image_effect_command_journal_command_journal_id_seq
  TO platform_model_gateway;

GRANT EXECUTE ON FUNCTION platform.resolve_model_image_effect_access(TEXT,TEXT),
  platform.resolve_model_image_source_grant_authorizations(TEXT,TEXT[],TEXT[]),
  platform.resolve_model_image_option_authorization(TEXT,TEXT),
  platform.authorize_model_image_effect_output_read(
    TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,TIMESTAMPTZ),
  platform.consume_model_image_effect_budget_commit(
    TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
  TO platform_model_gateway;
GRANT EXECUTE ON FUNCTION platform.claim_model_image_effect_dispatch(TEXT,INTEGER),
  platform.heartbeat_model_image_effect_dispatch(TEXT,TEXT,BIGINT,INTEGER),
  platform.load_model_image_effect_dispatch_secrets(TEXT,TEXT,BIGINT),
  platform.load_model_image_effect_dispatch_context(TEXT,TEXT,BIGINT),
  platform.record_model_image_effect_observation(
    TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ,JSONB,JSONB,JSONB,TEXT,JSONB,TEXT),
  platform.dead_letter_model_image_effect_before_provider_io(TEXT,TEXT,BIGINT,TEXT),
  platform.return_model_image_effect_dispatch_leases(TEXT,TEXT)
  TO platform_model_image_worker;

REVOKE CREATE ON SCHEMA platform FROM platform_model_gateway,platform_model_image_worker;
