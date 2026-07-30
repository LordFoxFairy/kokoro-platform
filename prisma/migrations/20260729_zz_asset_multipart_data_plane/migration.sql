SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.asset_multipart_upload (
  upload_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL,
  intent_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  client_upload_id TEXT NOT NULL CHECK (length(client_upload_id) BETWEEN 16 AND 128),
  provider_upload_id TEXT,
  capability_epoch BIGINT NOT NULL CHECK (capability_epoch > 0),
  state TEXT NOT NULL CHECK (state IN (
    'initiating','uploading','completing','uploaded','aborting','aborted',
    'integrity_rejected','outcome_unknown'
  )),
  outcome_operation TEXT CHECK (outcome_operation IN ('initiate','complete','abort')),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  initiation_idempotency_key TEXT NOT NULL CHECK (length(initiation_idempotency_key) BETWEEN 16 AND 191),
  initiation_request_digest CHAR(64) NOT NULL CHECK (initiation_request_digest ~ '^[a-f0-9]{64}$'),
  initiation_receipt_ref TEXT NOT NULL UNIQUE,
  initiation_effect_token TEXT,
  initiation_effect_lease_expires_at TIMESTAMPTZ,
  completion_idempotency_key TEXT CHECK (length(completion_idempotency_key) BETWEEN 16 AND 191),
  completion_request_digest CHAR(64) CHECK (completion_request_digest ~ '^[a-f0-9]{64}$'),
  completion_receipt_ref TEXT UNIQUE,
  completion_effect_token TEXT,
  completion_effect_lease_expires_at TIMESTAMPTZ,
  abort_idempotency_key TEXT CHECK (length(abort_idempotency_key) BETWEEN 16 AND 191),
  abort_request_digest CHAR(64) CHECK (abort_request_digest ~ '^[a-f0-9]{64}$'),
  abort_receipt_ref TEXT UNIQUE,
  abort_effect_token TEXT,
  abort_effect_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(site_ref,upload_ref),
  UNIQUE(site_ref,session_ref),
  UNIQUE(site_ref,session_ref,client_upload_id),
  FOREIGN KEY(site_ref,intent_ref)
    REFERENCES platform.asset_upload_intent(site_ref,intent_ref),
  FOREIGN KEY(site_ref,session_ref)
    REFERENCES platform.asset_upload_session(site_ref,session_ref),
  CHECK ((state='outcome_unknown') = (outcome_operation IS NOT NULL)),
  CHECK ((completion_idempotency_key IS NULL) = (completion_request_digest IS NULL)),
  CHECK ((completion_idempotency_key IS NULL) = (completion_receipt_ref IS NULL)),
  CHECK ((abort_idempotency_key IS NULL) = (abort_request_digest IS NULL)),
  CHECK ((abort_idempotency_key IS NULL) = (abort_receipt_ref IS NULL)),
  CHECK ((initiation_effect_token IS NULL) = (initiation_effect_lease_expires_at IS NULL)),
  CHECK (initiation_effect_token IS NULL OR state IN ('initiating','outcome_unknown')),
  CHECK ((completion_effect_token IS NULL) = (completion_effect_lease_expires_at IS NULL)),
  CHECK (completion_effect_token IS NULL OR state='completing' OR
    (state='outcome_unknown' AND outcome_operation='complete')),
  CHECK ((abort_effect_token IS NULL) = (abort_effect_lease_expires_at IS NULL)),
  CHECK (abort_effect_token IS NULL OR state='aborting' OR
    (state='outcome_unknown' AND outcome_operation='abort')),
  CHECK (provider_upload_id IS NOT NULL OR state IN ('initiating','outcome_unknown'))
);
CREATE INDEX asset_multipart_upload_reconcile_idx
  ON platform.asset_multipart_upload(site_ref,state,updated_at);

CREATE TABLE platform.asset_multipart_part (
  site_ref TEXT NOT NULL,
  upload_ref TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  part_receipt TEXT NOT NULL UNIQUE,
  provider_etag TEXT CHECK (length(provider_etag) BETWEEN 1 AND 512),
  size BIGINT NOT NULL CHECK (size > 0),
  checksum_sha256 CHAR(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 191),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending','retryable','committed','outcome_unknown')),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  effect_token TEXT,
  effect_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(site_ref,upload_ref,part_number),
  FOREIGN KEY(site_ref,upload_ref)
    REFERENCES platform.asset_multipart_upload(site_ref,upload_ref),
  UNIQUE(site_ref,upload_ref,idempotency_key),
  CHECK ((state='committed') = (provider_etag IS NOT NULL)),
  CHECK ((effect_token IS NULL) = (effect_lease_expires_at IS NULL)),
  CHECK ((state='pending') = (effect_token IS NOT NULL))
);

CREATE FUNCTION platform.guard_asset_multipart_upload_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.upload_ref,OLD.site_ref,OLD.intent_ref,OLD.session_ref,OLD.client_upload_id,
    OLD.capability_epoch,OLD.initiation_idempotency_key,OLD.initiation_request_digest,
    OLD.initiation_receipt_ref,OLD.created_at) IS DISTINCT FROM
    ROW(NEW.upload_ref,NEW.site_ref,NEW.intent_ref,NEW.session_ref,NEW.client_upload_id,
    NEW.capability_epoch,NEW.initiation_idempotency_key,NEW.initiation_request_digest,
    NEW.initiation_receipt_ref,NEW.created_at)
    OR NEW.expected_version<>OLD.expected_version+1
    OR (OLD.provider_upload_id IS NOT NULL AND NEW.provider_upload_id<>OLD.provider_upload_id)
    OR (OLD.completion_request_digest IS NOT NULL AND ROW(NEW.completion_idempotency_key,
      NEW.completion_request_digest,NEW.completion_receipt_ref) IS DISTINCT FROM
      ROW(OLD.completion_idempotency_key,OLD.completion_request_digest,OLD.completion_receipt_ref))
    OR (OLD.abort_request_digest IS NOT NULL AND ROW(NEW.abort_idempotency_key,
      NEW.abort_request_digest,NEW.abort_receipt_ref) IS DISTINCT FROM
      ROW(OLD.abort_idempotency_key,OLD.abort_request_digest,OLD.abort_receipt_ref))
    OR NOT (CASE OLD.state
      WHEN 'initiating' THEN NEW.state IN ('initiating','uploading','outcome_unknown')
      WHEN 'uploading' THEN NEW.state IN ('completing','aborting')
      WHEN 'completing' THEN NEW.state IN ('completing','uploaded','integrity_rejected','outcome_unknown')
      WHEN 'aborting' THEN NEW.state IN ('aborting','aborted','uploaded','integrity_rejected','outcome_unknown')
      WHEN 'outcome_unknown' THEN NEW.state IN (
        'uploading','completing','uploaded','aborting','aborted','integrity_rejected','outcome_unknown'
      )
      ELSE FALSE
    END) THEN
    RAISE EXCEPTION 'ASSET_MULTIPART_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_asset_multipart_upload_update() FROM PUBLIC;

CREATE TRIGGER asset_multipart_upload_update_guard
  BEFORE UPDATE ON platform.asset_multipart_upload
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_multipart_upload_update();

CREATE FUNCTION platform.guard_asset_multipart_part_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.site_ref,OLD.upload_ref,OLD.part_number,OLD.part_receipt,OLD.size,
    OLD.checksum_sha256,OLD.idempotency_key,OLD.request_digest,OLD.created_at) IS DISTINCT FROM
    ROW(NEW.site_ref,NEW.upload_ref,NEW.part_number,NEW.part_receipt,NEW.size,
    NEW.checksum_sha256,NEW.idempotency_key,NEW.request_digest,NEW.created_at)
    OR NEW.expected_version<>OLD.expected_version+1
    OR NOT (CASE OLD.state
      WHEN 'pending' THEN NEW.state IN ('pending','retryable','committed','outcome_unknown')
      WHEN 'retryable' THEN NEW.state IN ('pending')
      WHEN 'outcome_unknown' THEN NEW.state IN ('pending','retryable','committed','outcome_unknown')
      ELSE FALSE
    END) THEN
    RAISE EXCEPTION 'ASSET_MULTIPART_PART_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_asset_multipart_part_update() FROM PUBLIC;

CREATE TRIGGER asset_multipart_part_update_guard
  BEFORE UPDATE ON platform.asset_multipart_part
  FOR EACH ROW EXECUTE FUNCTION platform.guard_asset_multipart_part_update();

-- Asset Data Plane never receives direct read access to the shared outbox.
-- This exact SECURITY DEFINER command fixes owner/type, binds the event to the
-- transaction's capability-derived Site/session facts, and treats an event-id
-- collision as a conflict without requiring an outbox SELECT/UPDATE policy.
CREATE FUNCTION platform.enqueue_asset_upload_completion_event(
  requested_event_id UUID,
  requested_aggregate_id TEXT,
  requested_payload JSONB,
  requested_payload_digest CHAR(64),
  requested_correlation_id TEXT,
  requested_causation_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,platform
AS $$
DECLARE
  affected_rows INTEGER;
BEGIN
  IF current_setting('app.operation',true)<>'asset.multipart.complete'
     OR current_setting('app.workload_kind',true)<>'site_product'
     OR current_setting('app.actor_kind',true)<>'user'
     OR NOT (COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:upload')
     OR jsonb_typeof(requested_payload)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(
       CASE WHEN jsonb_typeof(requested_payload)='object' THEN requested_payload ELSE '{}'::JSONB END
     ))<>5
     OR requested_payload->>'kind'<>'asset_upload_completion_requested_v1'
     OR requested_payload->>'siteRef'<>current_setting('app.site_id',true)
     OR jsonb_typeof(requested_payload->'intentRef')<>'string'
     OR jsonb_typeof(requested_payload->'sessionRef')<>'string'
     OR jsonb_typeof(requested_payload->'expectedVersion')<>'string'
     OR length(requested_payload->>'intentRef') NOT BETWEEN 1 AND 256
     OR length(requested_payload->>'sessionRef') NOT BETWEEN 1 AND 256
     OR requested_aggregate_id<>requested_payload->>'sessionRef'
     OR (requested_payload->>'expectedVersion') !~ '^[1-9][0-9]{0,18}$'
     OR requested_payload_digest !~ '^[a-f0-9]{64}$'
     OR length(requested_correlation_id) NOT BETWEEN 1 AND 128
     OR length(requested_causation_id) NOT BETWEEN 1 AND 128
     OR requested_correlation_id ~ '[[:cntrl:]]'
     OR requested_causation_id ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'ASSET_COMPLETION_OUTBOX_EVENT_INVALID' USING ERRCODE='22023';
  END IF;

  INSERT INTO platform.outbox_event
    (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id,causation_id)
  VALUES
    (requested_event_id,'asset','asset.upload.completion.requested',requested_aggregate_id,
     requested_payload,requested_payload_digest,requested_correlation_id,requested_causation_id)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS affected_rows=ROW_COUNT;
  IF affected_rows<>1 THEN
    RAISE EXCEPTION 'ASSET_COMPLETION_OUTBOX_EVENT_CONFLICT' USING ERRCODE='23505';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION platform.enqueue_asset_upload_completion_event(
  UUID,TEXT,JSONB,CHAR(64),TEXT,TEXT
) FROM PUBLIC;

ALTER TABLE platform.asset_multipart_upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_multipart_upload FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_multipart_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.asset_multipart_part FORCE ROW LEVEL SECURITY;

CREATE POLICY asset_multipart_upload_owner_scope ON platform.asset_multipart_upload
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND EXISTS (
    SELECT 1 FROM platform.asset_upload_session session
    WHERE session.site_ref=asset_multipart_upload.site_ref
      AND session.session_ref=asset_multipart_upload.session_ref
      AND session.subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      AND session.subject_generation::TEXT=NULLIF(current_setting('app.subject_generation',true),'')
      AND session.project_ref=NULLIF(current_setting('app.project_id',true),'')
      AND session.purpose=NULLIF(current_setting('app.purpose',true),'')))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND EXISTS (
    SELECT 1 FROM platform.asset_upload_session session
    WHERE session.site_ref=asset_multipart_upload.site_ref
      AND session.session_ref=asset_multipart_upload.session_ref
      AND session.subject_ref=NULLIF(current_setting('app.subject_id',true),'')
      AND session.subject_generation::TEXT=NULLIF(current_setting('app.subject_generation',true),'')
      AND session.project_ref=NULLIF(current_setting('app.project_id',true),'')
      AND session.purpose=NULLIF(current_setting('app.purpose',true),'')));

CREATE POLICY asset_multipart_part_owner_scope ON platform.asset_multipart_part
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') AND EXISTS (
    SELECT 1 FROM platform.asset_multipart_upload upload
    WHERE upload.site_ref=asset_multipart_part.site_ref
      AND upload.upload_ref=asset_multipart_part.upload_ref))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') AND EXISTS (
    SELECT 1 FROM platform.asset_multipart_upload upload
    WHERE upload.site_ref=asset_multipart_part.site_ref
      AND upload.upload_ref=asset_multipart_part.upload_ref));
