SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admission_media_access_authorization (
  handle_digest CHAR(64) PRIMARY KEY CHECK(handle_digest ~ '^[a-f0-9]{64}$'),
  site_id TEXT NOT NULL REFERENCES platform.site(site_ref),
  project_ref TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  configuration_revision_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  projection_reservation_digest CHAR(64) NOT NULL
    CHECK(projection_reservation_digest ~ '^[a-f0-9]{64}$'),
  reservation_receipt_ref TEXT NOT NULL,
  input_policy_decision_ref TEXT NOT NULL,
  execution_manifest_ref TEXT,
  execution_budget_root_ref UUID,
  root_hold_ref UUID,
  authorization_segment_ref UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','active','revoked','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_id,command_id),
  CHECK((execution_manifest_ref IS NULL)=(execution_budget_root_ref IS NULL)),
  CHECK((execution_manifest_ref IS NULL)=(root_hold_ref IS NULL)),
  CHECK((execution_manifest_ref IS NULL)=(authorization_segment_ref IS NULL)),
  CHECK(state='reserved' OR execution_manifest_ref IS NOT NULL)
);

CREATE TABLE platform.media_operation_definition_revision (
  definition_revision_ref TEXT PRIMARY KEY,
  definition_key TEXT NOT NULL CHECK(definition_key='image.text_to_image@v1'),
  media_kind TEXT NOT NULL CHECK(media_kind='image_text_to_image'),
  contract_major INTEGER NOT NULL CHECK(contract_major=1),
  maximum_candidate_count INTEGER NOT NULL CHECK(maximum_candidate_count BETWEEN 1 AND 4),
  prompt_maximum_utf8_bytes INTEGER NOT NULL CHECK(prompt_maximum_utf8_bytes=32768),
  supported_aspect_ratios JSONB NOT NULL CHECK(jsonb_typeof(supported_aspect_ratios)='array'),
  supported_output_formats JSONB NOT NULL CHECK(jsonb_typeof(supported_output_formats)='array'),
  published_at TIMESTAMPTZ NOT NULL,
  UNIQUE(definition_key,definition_revision_ref)
);

INSERT INTO platform.media_operation_definition_revision(
  definition_revision_ref,definition_key,media_kind,contract_major,maximum_candidate_count,
  prompt_maximum_utf8_bytes,supported_aspect_ratios,supported_output_formats,published_at
) VALUES(
  'image.text_to_image@v1:revision:1','image.text_to_image@v1','image_text_to_image',1,4,32768,
  '["square_1_1","landscape_4_3","landscape_16_9","portrait_3_4","portrait_9_16"]'::jsonb,
  '["png","jpeg","webp"]'::jsonb,statement_timestamp()
);

CREATE TABLE platform.site_release_media_definition (
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  site_release_ref TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK(media_kind='image_text_to_image'),
  definition_revision_ref TEXT NOT NULL
    REFERENCES platform.media_operation_definition_revision(definition_revision_ref),
  maximum_credit NUMERIC(38,0) NOT NULL CHECK(maximum_credit > 0),
  published_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(site_ref,site_release_ref,media_kind),
  FOREIGN KEY(site_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref)
);

CREATE TABLE platform.media_operation_input_revision (
  operation_input_revision_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  workload_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('direct_studio','agent_runtime')),
  definition_revision_ref TEXT NOT NULL,
  model_option_revision_ref TEXT NOT NULL,
  encryption_algorithm TEXT NOT NULL CHECK(encryption_algorithm='AES-256-GCM-envelope-v1'),
  key_revision_ref TEXT NOT NULL,
  ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 65536),
  content_iv BYTEA NOT NULL CHECK(octet_length(content_iv)=12),
  content_tag BYTEA NOT NULL CHECK(octet_length(content_tag)=16),
  wrapped_dek BYTEA NOT NULL CHECK(octet_length(wrapped_dek)=32),
  wrap_iv BYTEA NOT NULL CHECK(octet_length(wrap_iv)=12),
  wrap_tag BYTEA NOT NULL CHECK(octet_length(wrap_tag)=16),
  plaintext_bytes INTEGER NOT NULL CHECK(plaintext_bytes BETWEEN 1 AND 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(operation_input_revision_ref,site_ref,subject_ref,subject_generation,project_ref)
);

ALTER TABLE platform.credit_allocation_reservation_receipt
  ADD CONSTRAINT credit_media_receipt_exact_owner_unique
  UNIQUE(allocation_reservation_receipt_ref,site_ref,execution_budget_root_ref,
    parent_allocation_ref,child_allocation_ref,media_operation_ref);

CREATE TABLE platform.media_operation (
  operation_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  operation_input_revision_ref TEXT NOT NULL UNIQUE,
  definition_revision_ref TEXT NOT NULL,
  model_option_revision_ref TEXT NOT NULL,
  caller_request_fingerprint CHAR(64) NOT NULL CHECK(caller_request_fingerprint ~ '^[a-f0-9]{64}$'),
  owner_request_digest CHAR(64) NOT NULL CHECK(owner_request_digest ~ '^[a-f0-9]{64}$'),
  credit_execution_budget_root_ref UUID NOT NULL,
  credit_parent_allocation_ref UUID NOT NULL,
  credit_child_allocation_ref UUID NOT NULL,
  credit_allocation_receipt_ref UUID NOT NULL,
  trust_input_decision_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('admission_pending','authorized','queued','active','finalizing','reconciling',
     'cancel_requested','completed','partial','failed','canceled')),
  outcome_class TEXT CHECK(outcome_class IN ('canonical','irreconcilable')),
  owner_version BIGINT NOT NULL CHECK(owner_version > 0),
  terminal_receipt_ref TEXT,
  usage_evidence_receipt_ref TEXT,
  effect_budget_commit_ref TEXT,
  session_projection_receipt_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(operation_ref,site_ref,subject_ref,subject_generation,project_ref),
  FOREIGN KEY(operation_input_revision_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation_input_revision(
      operation_input_revision_ref,site_ref,subject_ref,subject_generation,project_ref
    ),
  FOREIGN KEY(credit_allocation_receipt_ref,site_ref,credit_execution_budget_root_ref,
      credit_parent_allocation_ref,credit_child_allocation_ref,operation_ref)
    REFERENCES platform.credit_allocation_reservation_receipt(
      allocation_reservation_receipt_ref,site_ref,execution_budget_root_ref,
      parent_allocation_ref,child_allocation_ref,media_operation_ref
    ),
  CHECK((state IN ('completed','partial','failed','canceled')) = (terminal_receipt_ref IS NOT NULL)),
  CHECK((state IN ('completed','partial','failed','canceled')) = (outcome_class IS NOT NULL)),
  CHECK(terminal_receipt_ref IS NULL OR
    (usage_evidence_receipt_ref IS NOT NULL AND effect_budget_commit_ref IS NOT NULL AND
     session_projection_receipt_ref IS NOT NULL))
);

CREATE TABLE platform.media_command_journal (
  caller_audience TEXT NOT NULL,
  access_authorization_handle_digest CHAR(64) NOT NULL
    REFERENCES platform.admission_media_access_authorization(handle_digest),
  projection_reservation_digest CHAR(64) NOT NULL
    CHECK(projection_reservation_digest ~ '^[a-f0-9]{64}$'),
  authorization_reservation_receipt_ref TEXT NOT NULL,
  authorization_expires_at TIMESTAMPTZ NOT NULL,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  workload_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source='agent_runtime'),
  definition_revision_ref TEXT NOT NULL,
  model_option_revision_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  caller_request_fingerprint CHAR(64) NOT NULL CHECK(caller_request_fingerprint ~ '^[a-f0-9]{64}$'),
  owner_request_digest CHAR(64) NOT NULL CHECK(owner_request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('processing','committed')),
  lease_token_hash CHAR(64) NOT NULL CHECK(lease_token_hash ~ '^[a-f0-9]{64}$'),
  operation_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref),
  FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation(operation_ref,site_ref,subject_ref,subject_generation,project_ref),
  CHECK((state='processing' AND operation_ref IS NULL) OR
        (state='committed' AND operation_ref IS NOT NULL))
);

CREATE TABLE platform.media_command_receipt (
  caller_audience TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  receipt_version BIGINT NOT NULL CHECK(receipt_version > 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  command_kind TEXT NOT NULL CHECK(command_kind='create_agent_image_operation'),
  outcome TEXT NOT NULL CHECK(outcome IN ('submit_outcome_unknown','submit_accepted')),
  operation_ref TEXT,
  PRIMARY KEY(caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref,receipt_version),
  FOREIGN KEY(caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref)
    REFERENCES platform.media_command_journal(
      caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref
    ),
  FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation(operation_ref,site_ref,subject_ref,subject_generation,project_ref),
  CHECK((outcome='submit_outcome_unknown' AND receipt_version=1 AND operation_ref IS NULL) OR
        (outcome='submit_accepted' AND receipt_version=2 AND operation_ref IS NOT NULL))
);

CREATE FUNCTION platform.reject_media_command_receipt_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'MEDIA_COMMAND_RECEIPT_IMMUTABLE' USING ERRCODE='23000';
END;
$$;
CREATE TRIGGER media_command_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.media_command_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_command_receipt_mutation();
REVOKE ALL ON FUNCTION platform.reject_media_command_receipt_mutation() FROM PUBLIC;

CREATE TABLE platform.media_candidate (
  candidate_ref TEXT PRIMARY KEY,
  operation_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  definition_step_key TEXT NOT NULL,
  output_slot TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 16),
  required BOOLEAN NOT NULL,
  model_invocation_command_ref TEXT NOT NULL,
  artifact_ref TEXT NOT NULL UNIQUE,
  artifact_version_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN
    ('allocated','producing','output_received','validating','ready','restricted','failed',
     'cancel_requested','canceled','unknown')),
  owner_version BIGINT NOT NULL CHECK(owner_version > 0),
  UNIQUE(operation_ref,output_slot),
  UNIQUE(operation_ref,ordinal),
  FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
);

CREATE TABLE platform.media_dispatch_outbox (
  outbox_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  operation_ref TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL CHECK(topic='media.image.dispatch.v1'),
  state TEXT NOT NULL CHECK(state IN ('pending','leased','completed','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 100),
  lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  lease_token_hash CHAR(64),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurred_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation(operation_ref,site_ref,subject_ref,subject_generation,project_ref),
  CHECK((state='leased')=(lease_token_hash IS NOT NULL)),
  CHECK((state='leased')=(worker_id IS NOT NULL)),
  CHECK((state='leased')=(lease_expires_at IS NOT NULL))
);

CREATE TABLE platform.media_provider_effect_journal (
  model_invocation_command_ref TEXT PRIMARY KEY,
  operation_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  adapter_kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started','recorded','outcome_unknown')),
  provider_effect_ref TEXT,
  outcome_receipt JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ,
  FOREIGN KEY(operation_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.media_operation(operation_ref,site_ref,subject_ref,subject_generation,project_ref),
  CHECK((state='recorded')=(provider_effect_ref IS NOT NULL)),
  CHECK((state='recorded')=(outcome_receipt IS NOT NULL))
);

CREATE TABLE platform.artifact (
  artifact_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  media_class TEXT NOT NULL CHECK(media_class='image'),
  current_artifact_version_ref TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(artifact_ref,site_ref,subject_ref,subject_generation,project_ref)
);

CREATE TABLE platform.artifact_version (
  artifact_version_ref TEXT PRIMARY KEY,
  artifact_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('reserved','retrieving','staged','validating','trust_pending','promotion_authorized',
     'promoting','ready_private','restricted','failed','reconciling','purge_pending','purged')),
  staged_object_ref TEXT,
  ready_object_ref TEXT,
  content_sha256 CHAR(64) CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_size BIGINT CHECK(byte_size BETWEEN 1 AND 33554432),
  media_type TEXT CHECK(media_type IN ('image/png','image/jpeg','image/webp')),
  trust_decision_ref TEXT,
  finalization_receipt_ref TEXT,
  owner_version BIGINT NOT NULL CHECK(owner_version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(artifact_ref,artifact_version_ref),
  UNIQUE(artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref),
  FOREIGN KEY(artifact_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.artifact(artifact_ref,site_ref,subject_ref,subject_generation,project_ref),
  CHECK(state<>'ready_private' OR
    (ready_object_ref IS NOT NULL AND staged_object_ref IS NULL AND content_sha256 IS NOT NULL AND
     byte_size IS NOT NULL AND media_type IS NOT NULL AND trust_decision_ref IS NOT NULL AND
     finalization_receipt_ref IS NOT NULL))
);

ALTER TABLE platform.artifact ADD CONSTRAINT artifact_current_version_fk
  FOREIGN KEY(artifact_ref,current_artifact_version_ref)
  REFERENCES platform.artifact_version(artifact_ref,artifact_version_ref) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE platform.media_candidate ADD CONSTRAINT media_candidate_artifact_version_fk
  FOREIGN KEY(artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref)
  REFERENCES platform.artifact_version(
    artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.artifact_delivery_authorization (
  authorization_ref TEXT PRIMARY KEY,
  capability_digest CHAR(64) NOT NULL UNIQUE CHECK(capability_digest ~ '^[a-f0-9]{64}$'),
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  project_ref TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  artifact_version_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('preview','download','export')),
  audience TEXT NOT NULL CHECK(audience='site-bff.artifact-delivery'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revocation_epoch BIGINT NOT NULL CHECK(revocation_epoch > 0),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY(artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref)
    REFERENCES platform.artifact_version(
      artifact_ref,artifact_version_ref,site_ref,subject_ref,subject_generation,project_ref
    ),
  CHECK(expires_at>issued_at)
);

ALTER TABLE platform.admission_media_access_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_media_access_authorization FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_media_access_scope ON platform.admission_media_access_authorization
  TO platform_admission
  USING(site_id=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));
CREATE POLICY admission_media_access_runtime_definer ON platform.admission_media_access_authorization
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime');

ALTER TABLE platform.site_release_media_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_media_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY site_release_media_definition_admin ON platform.site_release_media_definition
  TO platform_admin
  USING(site_ref=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),''));
CREATE POLICY site_release_media_definition_runtime_definer ON platform.site_release_media_definition
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime');

ALTER TABLE platform.media_operation_input_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_operation_input_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_operation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_command_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_command_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_command_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_command_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_dispatch_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_provider_effect_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_provider_effect_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_version FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_delivery_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_delivery_authorization FORCE ROW LEVEL SECURITY;

CREATE POLICY media_input_public_scope ON platform.media_operation_input_revision TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY media_operation_public_scope ON platform.media_operation TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY media_command_journal_public_scope ON platform.media_command_journal TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY media_candidate_public_scope ON platform.media_candidate TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY media_outbox_public_insert ON platform.media_dispatch_outbox TO platform_media_public
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));

-- Runtime owns no table privileges. These policies only let the migrator-owned,
-- SECURITY DEFINER routines cross FORCE RLS when the attested login role is the
-- dedicated Media Runtime. The routines remain the sole authorization surface.
CREATE POLICY media_input_runtime_definer ON platform.media_operation_input_revision
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY media_operation_runtime_definer ON platform.media_operation
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY media_command_journal_runtime_definer ON platform.media_command_journal
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY media_command_receipt_runtime_definer ON platform.media_command_receipt
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY media_candidate_runtime_definer ON platform.media_candidate
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY media_outbox_runtime_definer ON platform.media_dispatch_outbox
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY artifact_runtime_definer ON platform.artifact
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY artifact_version_runtime_definer ON platform.artifact_version
  TO platform_migrator
  USING(SESSION_USER='platform_media_runtime')
  WITH CHECK(SESSION_USER='platform_media_runtime');
CREATE POLICY artifact_public_scope ON platform.artifact TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY artifact_version_public_scope ON platform.artifact_version TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));
CREATE POLICY artifact_delivery_public_scope ON platform.artifact_delivery_authorization TO platform_media_public
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND
        subject_ref=NULLIF(current_setting('app.subject_ref',true),'') AND
        subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::bigint AND
        project_ref=NULLIF(current_setting('app.project_ref',true),''));

REVOKE ALL ON TABLE
  platform.admission_media_access_authorization,
  platform.media_operation_definition_revision,
  platform.site_release_media_definition,
  platform.media_operation_input_revision,
  platform.media_operation,
  platform.media_command_journal,
  platform.media_command_receipt,
  platform.media_candidate,
  platform.media_dispatch_outbox,
  platform.media_provider_effect_journal,
  platform.artifact,
  platform.artifact_version,
  platform.artifact_delivery_authorization
FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE ON platform.admission_media_access_authorization TO platform_admission;
GRANT SELECT ON platform.media_operation_definition_revision TO platform_admin;
GRANT SELECT,INSERT ON platform.site_release_media_definition TO platform_admin;
GRANT SELECT,INSERT,UPDATE ON
  platform.media_operation_input_revision,platform.media_operation,platform.media_command_journal,
  platform.media_candidate,platform.artifact,platform.artifact_version,
  platform.artifact_delivery_authorization
TO platform_media_public;
GRANT INSERT ON platform.media_dispatch_outbox TO platform_media_public;

CREATE TABLE platform.media_runtime_role_identity (
  role_kind TEXT PRIMARY KEY CHECK(role_kind IN ('runtime','worker')),
  role_name NAME NOT NULL UNIQUE,
  role_oid OID NOT NULL UNIQUE,
  CHECK((role_kind='runtime' AND role_name='platform_media_runtime') OR
        (role_kind='worker' AND role_name='platform_media_worker'))
);
INSERT INTO platform.media_runtime_role_identity(role_kind,role_name,role_oid)
SELECT 'runtime',rolname,oid FROM pg_roles WHERE rolname='platform_media_runtime'
UNION ALL
SELECT 'worker',rolname,oid FROM pg_roles WHERE rolname='platform_media_worker';
ALTER TABLE platform.media_runtime_role_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_runtime_role_identity FORCE ROW LEVEL SECURITY;
REVOKE ALL ON platform.media_runtime_role_identity FROM PUBLIC;
CREATE POLICY media_role_identity_definer ON platform.media_runtime_role_identity
  TO platform_migrator
  USING(SESSION_USER IN ('platform_media_runtime','platform_media_worker'));

CREATE POLICY media_outbox_worker_definer ON platform.media_dispatch_outbox
  TO platform_migrator
  USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');

CREATE FUNCTION platform.assert_media_runtime_role(expected_kind TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
DECLARE expected_name NAME; expected_oid OID; actual_oid OID;
BEGIN
  SELECT role_name,role_oid INTO STRICT expected_name,expected_oid
    FROM platform.media_runtime_role_identity WHERE role_kind=expected_kind;
  SELECT oid INTO STRICT actual_oid FROM pg_roles WHERE rolname=SESSION_USER;
  IF SESSION_USER<>expected_name::TEXT OR actual_oid<>expected_oid THEN
    RAISE EXCEPTION 'MEDIA_RUNTIME_ROLE_FORBIDDEN';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION platform.assert_media_runtime_role(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.assert_media_runtime_role(TEXT)
  TO platform_media_runtime,platform_media_worker;

CREATE FUNCTION platform.begin_media_image_command(
  p_caller_audience TEXT,p_handle_digest CHAR(64),p_projection_reservation_digest CHAR(64),
  p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,p_project_ref TEXT,
  p_workload_ref TEXT,p_source TEXT,p_definition_revision_ref TEXT,p_model_option_revision_ref TEXT,
  p_command_ref TEXT,p_caller_request_fingerprint CHAR(64),
  p_owner_request_digest CHAR(64),p_lease_token_hash CHAR(64)
) RETURNS TABLE(
  outcome TEXT,operation_ref TEXT,caller_request_fingerprint CHAR(64),
  receipt_version BIGINT,receipt_recorded_at TIMESTAMPTZ,receipt_kind TEXT,receipt_outcome TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
DECLARE
  prior platform.media_command_journal%ROWTYPE;
  authority platform.admission_media_access_authorization%ROWTYPE;
  resolved_definition_revision_ref TEXT;
  resolved_model_option_revision_ref TEXT;
BEGIN
  PERFORM platform.assert_media_runtime_role('runtime');
  IF p_caller_audience<>'ga.media-runtime' OR p_source<>'agent_runtime' THEN
    RAISE EXCEPTION 'MEDIA_RUNTIME_CALLER_AUDIENCE_FORBIDDEN';
  END IF;
  SELECT item.* INTO STRICT authority
    FROM platform.admission_media_access_authorization item
   WHERE item.handle_digest=p_handle_digest
     AND item.projection_reservation_digest=p_projection_reservation_digest
     AND item.state='active' AND item.expires_at>statement_timestamp();
  PERFORM set_config('app.site_id',authority.site_id,true);
  SELECT definition.definition_revision_ref,surface.default_model_option_revision_ref
    INTO STRICT resolved_definition_revision_ref,resolved_model_option_revision_ref
    FROM platform.site_release_media_definition definition
    JOIN platform.site_release_model_catalog_publication publication
      ON publication.site_id=authority.site_id
     AND publication.site_release_ref=authority.configuration_revision_id
    JOIN platform.site_release_model_catalog_surface surface
      ON surface.publication_id=publication.publication_id AND surface.surface_id='image'
    JOIN platform.credit_execution_budget_root root
      ON root.execution_budget_root_ref=authority.execution_budget_root_ref
     AND root.site_ref=authority.site_id AND root.state='open'
    JOIN platform.credit_authorization_segment segment
      ON segment.authorization_segment_ref=authority.authorization_segment_ref
     AND segment.execution_budget_root_ref=root.execution_budget_root_ref
     AND segment.site_ref=authority.site_id AND segment.state='committed'
   WHERE definition.site_ref=authority.site_id
     AND definition.site_release_ref=authority.configuration_revision_id
     AND definition.media_kind='image_text_to_image';
  IF ROW(p_site_ref,p_subject_ref,p_subject_generation,p_project_ref,
         p_definition_revision_ref,p_model_option_revision_ref)
     IS DISTINCT FROM ROW(authority.site_id,authority.subject_ref,authority.subject_generation,
         authority.project_ref,resolved_definition_revision_ref,resolved_model_option_revision_ref) THEN
    RAISE EXCEPTION 'MEDIA_ACCESS_OWNER_BINDING_INVALID';
  END IF;
  INSERT INTO platform.media_command_journal(
    caller_audience,access_authorization_handle_digest,projection_reservation_digest,
    authorization_reservation_receipt_ref,authorization_expires_at,
    site_ref,subject_ref,subject_generation,project_ref,workload_ref,source,
    definition_revision_ref,model_option_revision_ref,command_ref,
    caller_request_fingerprint,owner_request_digest,state,lease_token_hash
  ) VALUES(
    p_caller_audience,p_handle_digest,p_projection_reservation_digest,
    authority.reservation_receipt_ref,authority.expires_at,
    authority.site_id,authority.subject_ref,authority.subject_generation,authority.project_ref,
    p_workload_ref,p_source,resolved_definition_revision_ref,resolved_model_option_revision_ref,p_command_ref,
    p_caller_request_fingerprint,p_owner_request_digest,'processing',p_lease_token_hash
  ) ON CONFLICT (caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref)
    DO NOTHING;
  IF FOUND THEN
    INSERT INTO platform.media_command_receipt(
      caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref,
      receipt_version,recorded_at,command_kind,outcome
    ) VALUES(
      p_caller_audience,authority.site_id,authority.subject_ref,authority.subject_generation,
      authority.project_ref,p_command_ref,1,statement_timestamp(),
      'create_agent_image_operation','submit_outcome_unknown'
    );
    RETURN QUERY
    SELECT 'started'::TEXT,NULL::TEXT,p_caller_request_fingerprint,receipt.receipt_version,
           receipt.recorded_at,receipt.command_kind,receipt.outcome
      FROM platform.media_command_receipt receipt
     WHERE receipt.caller_audience=p_caller_audience AND receipt.site_ref=authority.site_id
       AND receipt.subject_ref=authority.subject_ref
       AND receipt.subject_generation=authority.subject_generation
       AND receipt.project_ref=authority.project_ref AND receipt.command_ref=p_command_ref
       AND receipt.receipt_version=1;
    RETURN;
  END IF;
  SELECT * INTO STRICT prior FROM platform.media_command_journal journal
   WHERE journal.caller_audience=p_caller_audience AND journal.site_ref=p_site_ref
     AND journal.subject_ref=p_subject_ref AND journal.subject_generation=p_subject_generation
     AND journal.project_ref=p_project_ref AND journal.command_ref=p_command_ref FOR UPDATE;
  IF prior.caller_request_fingerprint<>p_caller_request_fingerprint OR
     prior.owner_request_digest<>p_owner_request_digest OR
     prior.access_authorization_handle_digest<>p_handle_digest OR
     prior.projection_reservation_digest<>p_projection_reservation_digest OR
     ROW(prior.workload_ref,prior.source,prior.definition_revision_ref,prior.model_option_revision_ref)
       IS DISTINCT FROM ROW(p_workload_ref,p_source,p_definition_revision_ref,p_model_option_revision_ref) THEN
    RAISE EXCEPTION 'MEDIA_COMMAND_OWNER_DIGEST_CONFLICT';
  END IF;
  IF prior.state='processing' THEN RAISE EXCEPTION 'MEDIA_COMMAND_PENDING'; END IF;
  RETURN QUERY
  SELECT 'replayed'::TEXT,prior.operation_ref,prior.caller_request_fingerprint,
         receipt.receipt_version,receipt.recorded_at,receipt.command_kind,receipt.outcome
    FROM platform.media_command_receipt receipt
   WHERE receipt.caller_audience=prior.caller_audience AND receipt.site_ref=prior.site_ref
     AND receipt.subject_ref=prior.subject_ref AND receipt.subject_generation=prior.subject_generation
     AND receipt.project_ref=prior.project_ref AND receipt.command_ref=prior.command_ref
   ORDER BY receipt.receipt_version DESC LIMIT 1;
END;
$$;
REVOKE ALL ON FUNCTION platform.begin_media_image_command(
  TEXT,CHAR,CHAR,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,CHAR,CHAR,CHAR
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.begin_media_image_command(
  TEXT,CHAR,CHAR,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,CHAR,CHAR,CHAR
) TO platform_media_runtime;

CREATE FUNCTION platform.commit_media_image_operation(
  p_record JSONB,p_lease_token_hash CHAR(64)
) RETURNS TABLE(
  operation_ref TEXT,caller_request_fingerprint CHAR(64),receipt_version BIGINT,
  receipt_recorded_at TIMESTAMPTZ,receipt_kind TEXT,receipt_outcome TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
DECLARE
  owner JSONB; command_record JSONB; protected_input JSONB; operation_record JSONB;
  credit_record JSONB; outbox_record JSONB; candidate JSONB; candidate_ordinal BIGINT;
  journal_record platform.media_command_journal%ROWTYPE;
  authority_record platform.admission_media_access_authorization%ROWTYPE;
  changed INTEGER;
BEGIN
  PERFORM platform.assert_media_runtime_role('runtime');
  IF jsonb_typeof(p_record)<>'object' OR jsonb_typeof(p_record->'owner')<>'object' OR
     jsonb_typeof(p_record->'command')<>'object' OR
     jsonb_typeof(p_record->'protectedInput')<>'object' OR
     jsonb_typeof(p_record->'operation')<>'object' OR
     jsonb_typeof(p_record->'credit')<>'object' OR
     jsonb_typeof(p_record->'outbox')<>'object' OR
     jsonb_typeof(p_record->'candidates')<>'array' OR
     jsonb_array_length(p_record->'candidates') NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'MEDIA_OPERATION_RECORD_INVALID';
  END IF;
  owner:=p_record->'owner'; command_record:=p_record->'command';
  protected_input:=p_record->'protectedInput'; operation_record:=p_record->'operation';
  credit_record:=p_record->'credit'; outbox_record:=p_record->'outbox';
  SELECT journal,authority INTO STRICT journal_record,authority_record
    FROM platform.media_command_journal journal
    JOIN platform.admission_media_access_authorization authority
      ON authority.handle_digest=journal.access_authorization_handle_digest
     AND authority.projection_reservation_digest=journal.projection_reservation_digest
     AND authority.site_id=journal.site_ref
     AND authority.subject_ref=journal.subject_ref
     AND authority.subject_generation=journal.subject_generation
     AND authority.project_ref=journal.project_ref
     AND authority.reservation_receipt_ref=journal.authorization_reservation_receipt_ref
     AND authority.expires_at=journal.authorization_expires_at
     AND authority.state='active' AND authority.expires_at>statement_timestamp()
   WHERE journal.caller_audience=command_record->>'callerAudience'
     AND journal.command_ref=command_record->>'commandRef'
     AND journal.lease_token_hash=p_lease_token_hash
     AND journal.state='processing'
   FOR UPDATE OF journal;
  IF command_record->>'callerAudience'<>'ga.media-runtime' OR journal_record.source<>'agent_runtime' OR
     command_record->>'callerRequestFingerprint'<>journal_record.caller_request_fingerprint OR
     command_record->>'ownerRequestDigest'<>journal_record.owner_request_digest OR
     operation_record->>'definitionRevisionRef'<>journal_record.definition_revision_ref OR
     operation_record->>'modelOptionRevisionRef'<>journal_record.model_option_revision_ref THEN
    RAISE EXCEPTION 'MEDIA_OPERATION_OWNER_BINDING_INVALID';
  END IF;

  INSERT INTO platform.media_operation_input_revision(
    operation_input_revision_ref,site_ref,subject_ref,subject_generation,project_ref,
    workload_ref,source,definition_revision_ref,model_option_revision_ref,encryption_algorithm,
    key_revision_ref,ciphertext,content_iv,content_tag,wrapped_dek,wrap_iv,wrap_tag,
    plaintext_bytes,created_at
  ) VALUES(
    protected_input->>'operationInputRevisionRef',journal_record.site_ref,journal_record.subject_ref,
    journal_record.subject_generation,journal_record.project_ref,journal_record.workload_ref,
    journal_record.source,journal_record.definition_revision_ref,journal_record.model_option_revision_ref,
    protected_input->>'encryptionAlgorithm',protected_input->>'keyRevisionRef',
    decode(protected_input->>'ciphertextBase64','base64'),
    decode(protected_input->>'contentIvBase64','base64'),
    decode(protected_input->>'contentTagBase64','base64'),
    decode(protected_input->>'wrappedDekBase64','base64'),
    decode(protected_input->>'wrapIvBase64','base64'),
    decode(protected_input->>'wrapTagBase64','base64'),
    (protected_input->>'plaintextBytes')::INTEGER,(p_record->>'createdAt')::TIMESTAMPTZ
  );
  INSERT INTO platform.media_operation(
    operation_ref,site_ref,subject_ref,subject_generation,project_ref,
    operation_input_revision_ref,definition_revision_ref,model_option_revision_ref,
    caller_request_fingerprint,owner_request_digest,credit_execution_budget_root_ref,
    credit_parent_allocation_ref,credit_child_allocation_ref,
    credit_allocation_receipt_ref,trust_input_decision_ref,state,owner_version,created_at,updated_at
  ) VALUES(
    operation_record->>'operationRef',journal_record.site_ref,journal_record.subject_ref,
    journal_record.subject_generation,journal_record.project_ref,
    protected_input->>'operationInputRevisionRef',journal_record.definition_revision_ref,
    journal_record.model_option_revision_ref,command_record->>'callerRequestFingerprint',
    command_record->>'ownerRequestDigest',(credit_record->>'executionBudgetRootRef')::UUID,
    (credit_record->>'parentAllocationRef')::UUID,(credit_record->>'childAllocationRef')::UUID,
    (credit_record->>'allocationReservationReceiptRef')::UUID,p_record->>'trustInputDecisionRef',
    'queued',(operation_record->>'ownerVersion')::BIGINT,
    (p_record->>'createdAt')::TIMESTAMPTZ,(p_record->>'createdAt')::TIMESTAMPTZ
  );
  FOR candidate,candidate_ordinal IN
    SELECT value,ordinality FROM jsonb_array_elements(p_record->'candidates') WITH ORDINALITY
  LOOP
    INSERT INTO platform.artifact(
      artifact_ref,site_ref,subject_ref,subject_generation,project_ref,media_class,
      current_artifact_version_ref,created_at,updated_at
    ) VALUES(
      candidate->>'artifactRef',journal_record.site_ref,journal_record.subject_ref,
      journal_record.subject_generation,journal_record.project_ref,'image',
      candidate->>'artifactVersionRef',(p_record->>'createdAt')::TIMESTAMPTZ,
      (p_record->>'createdAt')::TIMESTAMPTZ
    );
    INSERT INTO platform.artifact_version(
      artifact_version_ref,artifact_ref,site_ref,subject_ref,subject_generation,project_ref,
      state,owner_version,created_at,updated_at
    ) VALUES(
      candidate->>'artifactVersionRef',candidate->>'artifactRef',journal_record.site_ref,
      journal_record.subject_ref,journal_record.subject_generation,journal_record.project_ref,
      'reserved',1,(p_record->>'createdAt')::TIMESTAMPTZ,(p_record->>'createdAt')::TIMESTAMPTZ
    );
    INSERT INTO platform.media_candidate(
      candidate_ref,operation_ref,site_ref,subject_ref,subject_generation,project_ref,
      definition_step_key,output_slot,ordinal,required,model_invocation_command_ref,
      artifact_ref,artifact_version_ref,state,owner_version
    ) VALUES(
      candidate->>'candidateRef',operation_record->>'operationRef',journal_record.site_ref,
      journal_record.subject_ref,journal_record.subject_generation,journal_record.project_ref,
      candidate->>'definitionStepKey',candidate->>'outputSlot',candidate_ordinal,
      (candidate->>'required')::BOOLEAN,p_record->>'modelInvocationCommandRef',
      candidate->>'artifactRef',candidate->>'artifactVersionRef','allocated',
      (candidate->>'ownerVersion')::BIGINT
    );
  END LOOP;
  INSERT INTO platform.media_dispatch_outbox(
    outbox_ref,site_ref,subject_ref,subject_generation,project_ref,operation_ref,topic,state,occurred_at
  ) VALUES(
    outbox_record->>'outboxRef',journal_record.site_ref,journal_record.subject_ref,
    journal_record.subject_generation,journal_record.project_ref,operation_record->>'operationRef',
    outbox_record->>'topic','pending',(outbox_record->>'occurredAt')::TIMESTAMPTZ
  );
  UPDATE platform.media_command_journal journal SET state='committed',
    operation_ref=operation_record->>'operationRef'
   WHERE journal.caller_audience=command_record->>'callerAudience'
     AND journal.site_ref=journal_record.site_ref AND journal.subject_ref=journal_record.subject_ref
     AND journal.subject_generation=journal_record.subject_generation
     AND journal.project_ref=journal_record.project_ref AND journal.command_ref=command_record->>'commandRef'
     AND journal.caller_request_fingerprint=command_record->>'callerRequestFingerprint'
     AND journal.owner_request_digest=command_record->>'ownerRequestDigest'
     AND journal.state='processing' AND journal.lease_token_hash=p_lease_token_hash;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'MEDIA_COMMAND_LEASE_LOST'; END IF;
  INSERT INTO platform.media_command_receipt(
    caller_audience,site_ref,subject_ref,subject_generation,project_ref,command_ref,
    receipt_version,recorded_at,command_kind,outcome,operation_ref
  ) VALUES(
    journal_record.caller_audience,journal_record.site_ref,journal_record.subject_ref,
    journal_record.subject_generation,journal_record.project_ref,journal_record.command_ref,
    2,statement_timestamp(),'create_agent_image_operation','submit_accepted',
    operation_record->>'operationRef'
  );
  RETURN QUERY
  SELECT receipt.operation_ref,journal_record.caller_request_fingerprint,receipt.receipt_version,
         receipt.recorded_at,receipt.command_kind,receipt.outcome
    FROM platform.media_command_receipt receipt
   WHERE receipt.caller_audience=journal_record.caller_audience
     AND receipt.site_ref=journal_record.site_ref AND receipt.subject_ref=journal_record.subject_ref
     AND receipt.subject_generation=journal_record.subject_generation
     AND receipt.project_ref=journal_record.project_ref AND receipt.command_ref=journal_record.command_ref
     AND receipt.receipt_version=2;
END;
$$;
REVOKE ALL ON FUNCTION platform.commit_media_image_operation(JSONB,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.commit_media_image_operation(JSONB,CHAR) TO platform_media_runtime;

CREATE FUNCTION platform.resolve_media_access(
  p_handle_digest CHAR(64),p_projection_reservation_digest CHAR(64)
) RETURNS TABLE(
  site_ref TEXT,project_ref TEXT,session_ref TEXT,run_ref TEXT,subject_ref TEXT,
  subject_generation BIGINT,configuration_revision_ref TEXT,execution_budget_root_ref UUID,
  authorization_segment_ref UUID,parent_allocation_ref UUID,maximum_credit NUMERIC,
  trust_input_decision_ref TEXT,definition_revision_ref TEXT,model_option_revision_ref TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
DECLARE resolved_site_ref TEXT;
BEGIN
  PERFORM platform.assert_media_runtime_role('runtime');
  SELECT authority.site_id INTO resolved_site_ref
    FROM platform.admission_media_access_authorization authority
   WHERE authority.handle_digest=p_handle_digest
     AND authority.projection_reservation_digest=p_projection_reservation_digest
     AND authority.state='active' AND authority.expires_at>statement_timestamp();
  IF NOT FOUND THEN RETURN; END IF;
  -- Credit tables are FORCE-RLS and site scoped. Derive the scope from the two
  -- opaque handles rather than accepting it as caller-controlled input.
  PERFORM set_config('app.site_id',resolved_site_ref,true);
  RETURN QUERY
  SELECT authority.site_id,authority.project_ref,authority.session_id,authority.run_id,
         authority.subject_ref,authority.subject_generation,authority.configuration_revision_id,
         authority.execution_budget_root_ref,authority.authorization_segment_ref,
         root.root_allocation_ref,definition.maximum_credit,authority.input_policy_decision_ref,
         definition.definition_revision_ref,surface.default_model_option_revision_ref
    FROM platform.admission_media_access_authorization authority
    JOIN platform.site_release_media_definition definition
      ON definition.site_ref=authority.site_id
     AND definition.site_release_ref=authority.configuration_revision_id
     AND definition.media_kind='image_text_to_image'
    JOIN platform.site_release_model_catalog_publication publication
      ON publication.site_id=authority.site_id
     AND publication.site_release_ref=authority.configuration_revision_id
    JOIN platform.site_release_model_catalog_surface surface
      ON surface.publication_id=publication.publication_id AND surface.surface_id='image'
    JOIN platform.credit_execution_budget_root root
      ON root.execution_budget_root_ref=authority.execution_budget_root_ref
     AND root.site_ref=authority.site_id AND root.state='open'
    JOIN platform.credit_authorization_segment segment
      ON segment.authorization_segment_ref=authority.authorization_segment_ref
     AND segment.execution_budget_root_ref=root.execution_budget_root_ref
     AND segment.site_ref=authority.site_id AND segment.state='committed'
   WHERE authority.handle_digest=p_handle_digest
     AND authority.projection_reservation_digest=p_projection_reservation_digest
     AND authority.state='active' AND authority.expires_at>statement_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION platform.resolve_media_access(CHAR,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.resolve_media_access(CHAR,CHAR) TO platform_media_runtime;

CREATE FUNCTION platform.recover_agent_media_command(
  p_handle_digest CHAR(64),p_caller_audience TEXT,p_command_ref TEXT
) RETURNS TABLE(
  command_state TEXT,caller_request_fingerprint CHAR(64),operation_ref TEXT,
  receipt_version BIGINT,receipt_recorded_at TIMESTAMPTZ,receipt_kind TEXT,receipt_outcome TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('runtime');
  IF p_caller_audience<>'ga.media-runtime' THEN
    RAISE EXCEPTION 'MEDIA_RUNTIME_CALLER_AUDIENCE_FORBIDDEN';
  END IF;
  RETURN QUERY
  SELECT journal.state,journal.caller_request_fingerprint,journal.operation_ref,
         receipt.receipt_version,receipt.recorded_at,receipt.command_kind,receipt.outcome
    FROM platform.admission_media_access_authorization authority
    JOIN platform.media_command_journal journal
      ON journal.site_ref=authority.site_id
     AND journal.subject_ref=authority.subject_ref
     AND journal.subject_generation=authority.subject_generation
     AND journal.project_ref=authority.project_ref
     AND journal.caller_audience=p_caller_audience
     AND journal.command_ref=p_command_ref
    JOIN LATERAL (
      SELECT item.receipt_version,item.recorded_at,item.command_kind,item.outcome
        FROM platform.media_command_receipt item
       WHERE item.caller_audience=journal.caller_audience AND item.site_ref=journal.site_ref
         AND item.subject_ref=journal.subject_ref AND item.subject_generation=journal.subject_generation
         AND item.project_ref=journal.project_ref AND item.command_ref=journal.command_ref
       ORDER BY item.receipt_version DESC LIMIT 1
    ) receipt ON true
   WHERE authority.handle_digest=p_handle_digest
     AND authority.state='active' AND authority.expires_at>statement_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION platform.recover_agent_media_command(CHAR,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.recover_agent_media_command(CHAR,TEXT,TEXT) TO platform_media_runtime;

CREATE FUNCTION platform.get_agent_media_operation(
  p_handle_digest CHAR(64),p_operation_ref TEXT
) RETURNS TABLE(
  operation_ref TEXT,owner_version BIGINT,operation_state TEXT,outcome_class TEXT,observed_at TIMESTAMPTZ,
  candidates JSONB
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('runtime');
  RETURN QUERY
  SELECT operation.operation_ref,operation.owner_version,operation.state,operation.outcome_class,
         operation.updated_at,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'candidateRef',candidate.candidate_ref,
             'ownerVersion',candidate.owner_version::TEXT,
             'state',candidate.state,
             'artifactVersionRef',CASE WHEN candidate.state='ready'
               THEN candidate.artifact_version_ref ELSE NULL END
           ) ORDER BY candidate.ordinal)
           FROM platform.media_candidate candidate
           WHERE candidate.operation_ref=operation.operation_ref
             AND candidate.site_ref=operation.site_ref
             AND candidate.subject_ref=operation.subject_ref
             AND candidate.subject_generation=operation.subject_generation
             AND candidate.project_ref=operation.project_ref
         ),'[]'::jsonb)
    FROM platform.admission_media_access_authorization authority
    JOIN platform.media_operation operation
      ON operation.site_ref=authority.site_id
     AND operation.subject_ref=authority.subject_ref
     AND operation.subject_generation=authority.subject_generation
     AND operation.project_ref=authority.project_ref
     AND operation.operation_ref=p_operation_ref
   WHERE authority.handle_digest=p_handle_digest
     AND authority.state='active' AND authority.expires_at>statement_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION platform.get_agent_media_operation(CHAR,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.get_agent_media_operation(CHAR,TEXT) TO platform_media_runtime;

CREATE FUNCTION platform.claim_media_image_task(
  p_worker_id TEXT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS TABLE(outbox_ref TEXT,operation_ref TEXT,lease_epoch BIGINT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  IF p_lease_seconds<1 OR p_lease_seconds>300 THEN RAISE EXCEPTION 'MEDIA_LEASE_INVALID'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT item.outbox_ref FROM platform.media_dispatch_outbox item
     WHERE item.state='pending' AND item.next_attempt_at<=statement_timestamp()
     ORDER BY item.occurred_at,item.outbox_ref FOR UPDATE SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE platform.media_dispatch_outbox item SET state='leased',attempt_count=attempt_count+1,
      lease_epoch=lease_epoch+1,lease_token_hash=p_lease_token_hash,worker_id=p_worker_id,
      lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
      FROM candidate WHERE item.outbox_ref=candidate.outbox_ref
      RETURNING item.outbox_ref,item.operation_ref,item.lease_epoch
  ) SELECT * FROM changed;
END;
$$;
REVOKE ALL ON FUNCTION platform.claim_media_image_task(TEXT,CHAR,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.claim_media_image_task(TEXT,CHAR,INTEGER) TO platform_media_worker;

REVOKE CREATE ON SCHEMA platform FROM platform_media_public,platform_media_runtime,platform_media_worker;
