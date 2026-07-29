SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- v2 is a successor feed with an independent cursor. Mixing v2 payloads into
-- the active v1 log would make v1 consumers decode an incompatible envelope.
CREATE TABLE platform.authorization_scoped_stream_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  high_watermark BIGINT NOT NULL DEFAULT 0 CHECK(high_watermark >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform.authorization_scoped_stream_state(singleton) VALUES(TRUE);

CREATE TABLE platform.authorization_scoped_site_cursor (
  site_ref TEXT PRIMARY KEY REFERENCES platform.authorization_site(site_ref),
  aggregate_sequence BIGINT NOT NULL DEFAULT 0 CHECK(aggregate_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.authorization_scoped_event_log (
  stream_sequence BIGINT PRIMARY KEY CHECK(stream_sequence > 0),
  event_id UUID NOT NULL UNIQUE,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  aggregate_sequence BIGINT NOT NULL CHECK(aggregate_sequence > 0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'site_current_changed','subject_current_changed','identity_session_current_changed',
    'project_membership_current_changed','grant_delivered'
  )),
  occurred_at TIMESTAMPTZ NOT NULL,
  signing_payload BYTEA NOT NULL CHECK(octet_length(signing_payload) BETWEEN 32 AND 1048576),
  payload_digest CHAR(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  signing_key_revision TEXT NOT NULL CHECK(length(signing_key_revision) BETWEEN 1 AND 128),
  signature_algorithm TEXT NOT NULL CHECK(signature_algorithm='RS256'),
  signature BYTEA NOT NULL CHECK(octet_length(signature) BETWEEN 64 AND 1024),
  correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,aggregate_sequence)
);
CREATE INDEX authorization_scoped_event_retention_idx
  ON platform.authorization_scoped_event_log(created_at,stream_sequence);

CREATE FUNCTION platform.reject_scoped_authorization_feed_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'AUTHORIZATION_SCOPED_EVENT_IMMUTABLE' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION platform.reject_scoped_authorization_feed_update() FROM PUBLIC;

CREATE TRIGGER authorization_scoped_event_immutable
BEFORE UPDATE ON platform.authorization_scoped_event_log
FOR EACH ROW EXECUTE FUNCTION platform.reject_scoped_authorization_feed_update();

REVOKE ALL ON
  platform.authorization_scoped_stream_state,
  platform.authorization_scoped_site_cursor,
  platform.authorization_scoped_event_log
FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
