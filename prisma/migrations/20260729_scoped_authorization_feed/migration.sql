SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Fresh production authority feed. Every owner mutation reserves this global
-- cursor and its Site cursor before changing the owner row.
CREATE TABLE platform.authorization_scoped_stream_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  high_watermark BIGINT NOT NULL DEFAULT 0 CHECK(high_watermark >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform.authorization_scoped_stream_state(singleton) VALUES(TRUE);

CREATE TABLE platform.authorization_scoped_site_cursor (
  -- No owner FK: reservation must acquire this Site lock before the owner row
  -- exists or is locked (including first activation). Transactional append and
  -- rollback preserve cursor/owner consistency.
  site_ref TEXT PRIMARY KEY,
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

CREATE TABLE platform.authorization_scoped_snapshot (
  snapshot_ref UUID PRIMARY KEY,
  high_watermark BIGINT NOT NULL CHECK(high_watermark >= 0),
  key_set_revision CHAR(64) NOT NULL CHECK(key_set_revision ~ '^[0-9a-f]{64}$'),
  frozen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expires_at > frozen_at)
);
CREATE INDEX authorization_scoped_snapshot_expiry_idx
  ON platform.authorization_scoped_snapshot(expires_at);

CREATE TABLE platform.authorization_scoped_snapshot_record (
  snapshot_ref UUID NOT NULL
    REFERENCES platform.authorization_scoped_snapshot(snapshot_ref) ON DELETE CASCADE,
  ordinal BIGINT NOT NULL CHECK(ordinal >= 0),
  record_payload BYTEA NOT NULL CHECK(octet_length(record_payload) BETWEEN 1 AND 1048576),
  PRIMARY KEY(snapshot_ref,ordinal)
);

CREATE FUNCTION platform.reject_scoped_authorization_feed_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'AUTHORIZATION_SCOPED_EVENT_IMMUTABLE' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION platform.reject_scoped_authorization_feed_update() FROM PUBLIC;

CREATE TRIGGER authorization_scoped_event_immutable
BEFORE UPDATE ON platform.authorization_scoped_event_log
FOR EACH ROW EXECUTE FUNCTION platform.reject_scoped_authorization_feed_update();

CREATE TRIGGER authorization_scoped_snapshot_immutable
BEFORE UPDATE ON platform.authorization_scoped_snapshot
FOR EACH ROW EXECUTE FUNCTION platform.reject_scoped_authorization_feed_update();

CREATE TRIGGER authorization_scoped_snapshot_record_immutable
BEFORE UPDATE ON platform.authorization_scoped_snapshot_record
FOR EACH ROW EXECUTE FUNCTION platform.reject_scoped_authorization_feed_update();

REVOKE ALL ON
  platform.authorization_scoped_stream_state,
  platform.authorization_scoped_site_cursor,
  platform.authorization_scoped_event_log,
  platform.authorization_scoped_snapshot,
  platform.authorization_scoped_snapshot_record
FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
