SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.asset_upload_intent (
  intent_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  project_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 128),
  safe_display_name TEXT NOT NULL CHECK (length(safe_display_name) BETWEEN 1 AND 255),
  client_media_type TEXT NOT NULL CHECK (length(client_media_type) BETWEEN 3 AND 192),
  expected_size BIGINT NOT NULL CHECK (expected_size > 0),
  expected_checksum_sha256 CHAR(64) NOT NULL CHECK (expected_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  policy_revision_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('admitted','aborted','rejected')),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,subject_ref,subject_generation,idempotency_key),
  UNIQUE(site_ref,intent_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref)
);
CREATE INDEX asset_upload_intent_owner_idx
  ON platform.asset_upload_intent(site_ref,subject_ref,state,expires_at);

CREATE TABLE platform.asset_upload_session (
  session_ref TEXT PRIMARY KEY,
  intent_ref TEXT NOT NULL UNIQUE,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  project_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 128),
  quota_revision_ref TEXT NOT NULL,
  storage_tenant_ref TEXT NOT NULL,
  storage_region TEXT NOT NULL,
  quarantine_object_ref TEXT NOT NULL,
  protocol_revision TEXT NOT NULL CHECK (protocol_revision='s3-multipart-v1'),
  capability_audience TEXT NOT NULL,
  minimum_part_bytes BIGINT NOT NULL CHECK (minimum_part_bytes > 0),
  maximum_part_bytes BIGINT NOT NULL CHECK (maximum_part_bytes >= minimum_part_bytes),
  capability_lifetime_seconds INTEGER NOT NULL CHECK (capability_lifetime_seconds BETWEEN 30 AND 900),
  capability_epoch BIGINT NOT NULL DEFAULT 0 CHECK (capability_epoch >= 0),
  capability_expires_at TIMESTAMPTZ,
  completion_requested_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_capability','uploading','completing','reconciling_upload',
    'validating','completed','aborting','aborted','rejected'
  )),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,session_ref),
  UNIQUE(storage_tenant_ref,storage_region,quarantine_object_ref),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  CHECK (capability_expires_at IS NULL OR capability_expires_at <= expires_at),
  CHECK ((capability_epoch=0 AND capability_expires_at IS NULL) OR capability_epoch > 0),
  CHECK (
    (state IN ('awaiting_capability','uploading') AND completion_requested_at IS NULL)
    OR (state NOT IN ('awaiting_capability','uploading') AND completion_requested_at IS NOT NULL)
  )
);
CREATE INDEX asset_upload_session_owner_idx
  ON platform.asset_upload_session(site_ref,subject_ref,state,expires_at);

CREATE TABLE platform.asset_quota_account (
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 128),
  quota_revision_ref TEXT NOT NULL,
  maximum_inflight_bytes BIGINT NOT NULL CHECK (maximum_inflight_bytes > 0),
  reserved_inflight_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_inflight_bytes >= 0),
  expected_version BIGINT NOT NULL DEFAULT 1 CHECK (expected_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,subject_ref,purpose),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  CHECK (reserved_inflight_bytes <= maximum_inflight_bytes)
);

CREATE TABLE platform.asset_quota_reservation (
  reservation_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  purpose TEXT NOT NULL,
  intent_ref TEXT NOT NULL UNIQUE,
  session_ref TEXT NOT NULL UNIQUE,
  quota_revision_ref TEXT NOT NULL,
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','committed','releasing','released')),
  release_evidence_ref TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,subject_ref,purpose)
    REFERENCES platform.asset_quota_account(site_ref,subject_ref,purpose),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(site_ref,session_ref)
    REFERENCES platform.asset_upload_session(site_ref,session_ref),
  CHECK ((state='released') = (release_evidence_ref IS NOT NULL))
);
CREATE INDEX asset_quota_reservation_owner_idx
  ON platform.asset_quota_reservation(site_ref,subject_ref,purpose,state,expires_at);

CREATE TABLE platform.asset_blob_candidate (
  candidate_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  project_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 128),
  intent_ref TEXT NOT NULL UNIQUE,
  session_ref TEXT NOT NULL UNIQUE,
  storage_tenant_ref TEXT NOT NULL,
  storage_region TEXT NOT NULL,
  quarantine_object_ref TEXT NOT NULL,
  provider_version_ref TEXT NOT NULL,
  provider_etag_digest CHAR(64) NOT NULL CHECK (provider_etag_digest ~ '^[a-f0-9]{64}$'),
  observed_size BIGINT NOT NULL CHECK (observed_size > 0),
  checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  client_media_type TEXT NOT NULL,
  policy_revision_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'checksum_verified','scanning','scan_unavailable','promotion_ready','rejected'
  )),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  completion_requested_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  scan_event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(site_ref,session_ref)
    REFERENCES platform.asset_upload_session(site_ref,session_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  UNIQUE(site_ref,candidate_ref),
  UNIQUE(storage_tenant_ref,storage_region,quarantine_object_ref,provider_version_ref),
  CHECK (observed_at >= completion_requested_at)
);
CREATE INDEX asset_blob_candidate_scan_idx
  ON platform.asset_blob_candidate(site_ref,state,observed_at);

CREATE TABLE platform.asset_upload_rejection (
  rejection_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  intent_ref TEXT NOT NULL UNIQUE,
  session_ref TEXT NOT NULL UNIQUE,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
  cleanup_event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(site_ref,session_ref)
    REFERENCES platform.asset_upload_session(site_ref,session_ref)
);

CREATE TABLE platform.asset_scan_evaluation (
  evaluation_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,
  candidate_version BIGINT NOT NULL CHECK (candidate_version > 0),
  policy_revision_ref TEXT NOT NULL,
  scanner_definition_ref TEXT NOT NULL,
  scanner_revision_ref TEXT NOT NULL,
  signature_revision_ref TEXT NOT NULL,
  detected_media_type TEXT NOT NULL,
  magic_signature_ref TEXT NOT NULL,
  container_summary_digest CHAR(64) NOT NULL CHECK (container_summary_digest ~ '^[a-f0-9]{64}$'),
  malware_disposition TEXT NOT NULL CHECK (malware_disposition IN ('clean','detected','unavailable')),
  content_safety_disposition TEXT NOT NULL CHECK (
    content_safety_disposition IN ('allow','deny','not_required','unavailable')
  ),
  evidence_ref TEXT NOT NULL,
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('clean','rejected','unavailable')),
  reason_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,candidate_ref)
    REFERENCES platform.asset_blob_candidate(site_ref,candidate_ref),
  UNIQUE(site_ref,candidate_ref,evidence_ref,evidence_digest)
);
CREATE INDEX asset_scan_evaluation_candidate_idx
  ON platform.asset_scan_evaluation(site_ref,candidate_ref,occurred_at);

CREATE TABLE platform.asset_promotion_intent (
  promotion_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  project_ref TEXT NOT NULL,
  purpose TEXT NOT NULL,
  intent_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  candidate_ref TEXT NOT NULL UNIQUE,
  evaluation_ref TEXT NOT NULL UNIQUE REFERENCES platform.asset_scan_evaluation(evaluation_ref),
  policy_revision_ref TEXT NOT NULL,
  asset_ref TEXT NOT NULL UNIQUE,
  asset_version_ref TEXT NOT NULL UNIQUE,
  blob_ref TEXT NOT NULL UNIQUE,
  storage_tenant_ref TEXT NOT NULL,
  storage_region TEXT NOT NULL,
  quarantine_object_ref TEXT NOT NULL,
  quarantine_provider_version_ref TEXT NOT NULL,
  trusted_object_ref TEXT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  size BIGINT NOT NULL CHECK (size > 0),
  detected_media_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending_copy','observing_copy','ready_to_finalize','completed','rejected'
  )),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  promotion_event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  copied_provider_version_ref TEXT,
  copied_provider_etag_digest CHAR(64),
  copied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,candidate_ref)
    REFERENCES platform.asset_blob_candidate(site_ref,candidate_ref),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(site_ref,session_ref)
    REFERENCES platform.asset_upload_session(site_ref,session_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  UNIQUE(site_ref,intent_ref,purpose),
  UNIQUE(storage_tenant_ref,storage_region,trusted_object_ref),
  CHECK ((copied_provider_version_ref IS NULL) = (copied_at IS NULL)),
  CHECK (copied_provider_etag_digest IS NULL OR copied_provider_etag_digest ~ '^[a-f0-9]{64}$')
);
CREATE INDEX asset_promotion_intent_state_idx
  ON platform.asset_promotion_intent(site_ref,state,updated_at);

CREATE FUNCTION platform.guard_asset_upload_intent_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.intent_ref,OLD.site_ref,OLD.workload_identity_id,OLD.site_release_ref,OLD.binding_epoch,
    OLD.subject_ref,OLD.subject_generation,OLD.project_ref,OLD.purpose,OLD.safe_display_name,
    OLD.client_media_type,OLD.expected_size,OLD.expected_checksum_sha256,OLD.policy_revision_ref,
    OLD.idempotency_key,OLD.request_digest,OLD.expires_at,OLD.created_at)
    IS DISTINCT FROM
    ROW(NEW.intent_ref,NEW.site_ref,NEW.workload_identity_id,NEW.site_release_ref,NEW.binding_epoch,
    NEW.subject_ref,NEW.subject_generation,NEW.project_ref,NEW.purpose,NEW.safe_display_name,
    NEW.client_media_type,NEW.expected_size,NEW.expected_checksum_sha256,NEW.policy_revision_ref,
    NEW.idempotency_key,NEW.request_digest,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_INTENT_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF (OLD.state <> NEW.state OR OLD.expected_version <> NEW.expected_version)
     AND NOT (OLD.state='admitted' AND NEW.state IN ('aborted','rejected')
       AND NEW.expected_version=OLD.expected_version+1) THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_INTENT_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.reject_asset_immutable_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'ASSET_IMMUTABLE_FACT' USING ERRCODE='23000';
END $$;

CREATE FUNCTION platform.guard_asset_blob_candidate_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.candidate_ref,OLD.site_ref,OLD.subject_ref,OLD.subject_generation,OLD.project_ref,
    OLD.purpose,OLD.intent_ref,OLD.session_ref,OLD.storage_tenant_ref,OLD.storage_region,
    OLD.quarantine_object_ref,OLD.provider_version_ref,OLD.provider_etag_digest,OLD.observed_size,
    OLD.checksum_sha256,OLD.client_media_type,OLD.policy_revision_ref,OLD.completion_requested_at,
    OLD.observed_at,OLD.scan_event_id,OLD.created_at)
    IS DISTINCT FROM
    ROW(NEW.candidate_ref,NEW.site_ref,NEW.subject_ref,NEW.subject_generation,NEW.project_ref,
    NEW.purpose,NEW.intent_ref,NEW.session_ref,NEW.storage_tenant_ref,NEW.storage_region,
    NEW.quarantine_object_ref,NEW.provider_version_ref,NEW.provider_etag_digest,NEW.observed_size,
    NEW.checksum_sha256,NEW.client_media_type,NEW.policy_revision_ref,NEW.completion_requested_at,
    NEW.observed_at,NEW.scan_event_id,NEW.created_at) THEN
    RAISE EXCEPTION 'ASSET_BLOB_CANDIDATE_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.expected_version<>OLD.expected_version+1 OR NOT (
    (OLD.state='checksum_verified' AND NEW.state='scanning')
    OR (OLD.state='scan_unavailable' AND NEW.state='scanning')
    OR (OLD.state='scanning' AND NEW.state IN ('scan_unavailable','promotion_ready','rejected'))
  ) THEN
    RAISE EXCEPTION 'ASSET_BLOB_CANDIDATE_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_asset_promotion_intent_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.promotion_ref,OLD.site_ref,OLD.subject_ref,OLD.subject_generation,OLD.project_ref,
    OLD.purpose,OLD.intent_ref,OLD.session_ref,OLD.candidate_ref,OLD.evaluation_ref,
    OLD.policy_revision_ref,OLD.asset_ref,OLD.asset_version_ref,OLD.blob_ref,
    OLD.storage_tenant_ref,OLD.storage_region,OLD.quarantine_object_ref,
    OLD.quarantine_provider_version_ref,OLD.trusted_object_ref,OLD.checksum_sha256,OLD.size,
    OLD.detected_media_type,OLD.promotion_event_id,OLD.created_at)
    IS DISTINCT FROM
    ROW(NEW.promotion_ref,NEW.site_ref,NEW.subject_ref,NEW.subject_generation,NEW.project_ref,
    NEW.purpose,NEW.intent_ref,NEW.session_ref,NEW.candidate_ref,NEW.evaluation_ref,
    NEW.policy_revision_ref,NEW.asset_ref,NEW.asset_version_ref,NEW.blob_ref,
    NEW.storage_tenant_ref,NEW.storage_region,NEW.quarantine_object_ref,
    NEW.quarantine_provider_version_ref,NEW.trusted_object_ref,NEW.checksum_sha256,NEW.size,
    NEW.detected_media_type,NEW.promotion_event_id,NEW.created_at) THEN
    RAISE EXCEPTION 'ASSET_PROMOTION_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.expected_version<>OLD.expected_version+1 OR NOT (
    (OLD.state='pending_copy' AND NEW.state IN ('observing_copy','rejected'))
    OR (OLD.state='observing_copy' AND NEW.state IN ('ready_to_finalize','rejected'))
    OR (OLD.state='ready_to_finalize' AND NEW.state IN ('completed','rejected'))
  ) THEN
    RAISE EXCEPTION 'ASSET_PROMOTION_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_asset_upload_session_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.session_ref,OLD.intent_ref,OLD.site_ref,OLD.subject_ref,OLD.subject_generation,
    OLD.project_ref,OLD.purpose,OLD.quota_revision_ref,OLD.storage_tenant_ref,OLD.storage_region,
    OLD.quarantine_object_ref,OLD.protocol_revision,OLD.capability_audience,OLD.minimum_part_bytes,
    OLD.maximum_part_bytes,OLD.capability_lifetime_seconds,OLD.expires_at,OLD.created_at)
    IS DISTINCT FROM
    ROW(NEW.session_ref,NEW.intent_ref,NEW.site_ref,NEW.subject_ref,NEW.subject_generation,
    NEW.project_ref,NEW.purpose,NEW.quota_revision_ref,NEW.storage_tenant_ref,NEW.storage_region,
    NEW.quarantine_object_ref,NEW.protocol_revision,NEW.capability_audience,NEW.minimum_part_bytes,
    NEW.maximum_part_bytes,NEW.capability_lifetime_seconds,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_SESSION_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.expected_version <> OLD.expected_version+1 THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_SESSION_VERSION_INVALID' USING ERRCODE='40001';
  END IF;
  IF OLD.completion_requested_at IS NOT NULL AND
     NEW.completion_requested_at IS DISTINCT FROM OLD.completion_requested_at THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_COMPLETION_TIME_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.state IN ('awaiting_capability','uploading') AND NEW.completion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_COMPLETION_TIME_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.state NOT IN ('awaiting_capability','uploading') AND NEW.completion_requested_at IS NULL THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_COMPLETION_TIME_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NEW.capability_epoch <> OLD.capability_epoch THEN
    IF OLD.state NOT IN ('awaiting_capability','uploading') OR NEW.state<>'uploading'
       OR NEW.capability_epoch<>OLD.capability_epoch+1 OR NEW.capability_expires_at IS NULL
       OR NEW.capability_expires_at>OLD.expires_at THEN
      RAISE EXCEPTION 'ASSET_UPLOAD_CAPABILITY_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.capability_expires_at IS DISTINCT FROM OLD.capability_expires_at
    OR NOT (
      (OLD.state='awaiting_capability' AND NEW.state IN ('aborting','rejected'))
      OR (OLD.state='uploading' AND NEW.state IN ('completing','aborting','rejected'))
      OR (OLD.state='completing' AND NEW.state IN ('validating','reconciling_upload','rejected'))
      OR (OLD.state='reconciling_upload' AND NEW.state IN ('validating','aborting','rejected'))
      OR (OLD.state='validating' AND NEW.state IN ('completed','rejected'))
      OR (OLD.state='aborting' AND NEW.state IN ('aborted','reconciling_upload'))
    ) THEN
    RAISE EXCEPTION 'ASSET_UPLOAD_SESSION_STATE_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE platform.asset_upload_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_upload_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_upload_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_upload_session FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_quota_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_quota_account FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_quota_reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_quota_reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_blob_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_blob_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_upload_rejection ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_upload_rejection FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_scan_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_scan_evaluation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_promotion_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_promotion_intent FORCE ROW LEVEL SECURITY;
CREATE POLICY asset_upload_intent_site_scope ON platform.asset_upload_intent
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_upload_session_site_scope ON platform.asset_upload_session
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_quota_account_site_scope ON platform.asset_quota_account
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_quota_reservation_site_scope ON platform.asset_quota_reservation
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND (subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      OR (current_setting('app.workload_kind',true)='platform_worker'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
      OR (current_setting('app.workload_kind',true)='admin_workload'
        AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_blob_candidate_worker_scope ON platform.asset_blob_candidate
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_upload_rejection_worker_scope ON platform.asset_upload_rejection
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_scan_evaluation_worker_scope ON platform.asset_scan_evaluation
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));
CREATE POLICY asset_promotion_intent_worker_scope ON platform.asset_promotion_intent
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND ((current_setting('app.workload_kind',true)='platform_worker'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker')
    OR (current_setting('app.workload_kind',true)='admin_workload'
      AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:admin')));

CREATE TRIGGER asset_upload_intent_update_guard
  BEFORE UPDATE ON platform.asset_upload_intent
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_upload_intent_update();
CREATE TRIGGER asset_upload_session_update_guard
  BEFORE UPDATE ON platform.asset_upload_session
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_upload_session_update();
CREATE TRIGGER asset_upload_rejection_immutable
  BEFORE UPDATE OR DELETE ON platform.asset_upload_rejection
  FOR EACH ROW EXECUTE FUNCTION platform.reject_asset_immutable_mutation();
CREATE TRIGGER asset_scan_evaluation_immutable
  BEFORE UPDATE OR DELETE ON platform.asset_scan_evaluation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_asset_immutable_mutation();
CREATE TRIGGER asset_blob_candidate_update_guard
  BEFORE UPDATE ON platform.asset_blob_candidate
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_blob_candidate_update();
CREATE TRIGGER asset_promotion_intent_update_guard
  BEFORE UPDATE ON platform.asset_promotion_intent
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_promotion_intent_update();

REVOKE ALL ON
  platform.asset_upload_intent,
  platform.asset_upload_session,
  platform.asset_quota_account,
  platform.asset_quota_reservation,
  platform.asset_blob_candidate,
  platform.asset_upload_rejection,
  platform.asset_scan_evaluation,
  platform.asset_promotion_intent
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_upload_intent_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_upload_session_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_asset_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_blob_candidate_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_promotion_intent_update() FROM PUBLIC;
