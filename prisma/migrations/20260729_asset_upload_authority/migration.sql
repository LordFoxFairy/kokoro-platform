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

CREATE TRIGGER asset_upload_intent_update_guard
  BEFORE UPDATE ON platform.asset_upload_intent
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_upload_intent_update();
CREATE TRIGGER asset_upload_session_update_guard
  BEFORE UPDATE ON platform.asset_upload_session
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_upload_session_update();

REVOKE ALL ON
  platform.asset_upload_intent,
  platform.asset_upload_session,
  platform.asset_quota_account,
  platform.asset_quota_reservation
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_upload_intent_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_asset_upload_session_update() FROM PUBLIC;
