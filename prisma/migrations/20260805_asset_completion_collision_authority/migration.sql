SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- This is a forward-only correction for deployments that already applied
-- 20260729_zz_asset_multipart_data_plane. FORCE RLS gives the function owner
-- INSERT-only Asset outbox authority, so a collision must not take PostgreSQL's
-- UPDATE path. A duplicate event id is deliberately surfaced as SQLSTATE 23505.
CREATE OR REPLACE FUNCTION platform.enqueue_asset_upload_completion_event(
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
