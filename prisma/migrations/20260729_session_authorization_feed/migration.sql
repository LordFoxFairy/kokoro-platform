SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.authorization_site
  ADD COLUMN event_sequence BIGINT NOT NULL DEFAULT 0 CHECK(event_sequence >= 0);

UPDATE platform.authorization_session_access_grant
SET delivery_state='failed',credential_digest=NULL,delivered_at=NULL,
    delivery_error_code='FEED_EPOCH_VECTOR_MIGRATION',failed_at=now()
WHERE delivery_state='delivered';
ALTER TABLE platform.authorization_session_access_grant
  ADD COLUMN site_security_epoch BIGINT,
  ADD COLUMN subject_generation BIGINT,
  ADD COLUMN identity_session_epoch BIGINT,
  ADD COLUMN membership_epoch BIGINT,
  ADD COLUMN authorization_epoch BIGINT,
  ADD COLUMN restriction_epoch BIGINT,
  ADD COLUMN credential_epoch BIGINT,
  ADD CONSTRAINT authorization_delivered_epoch_vector_required CHECK(
    delivery_state<>'delivered' OR (
      site_security_epoch>0 AND subject_generation>0 AND identity_session_epoch>0 AND
      membership_epoch>0 AND authorization_epoch>0 AND restriction_epoch>0 AND credential_epoch>0
    )
  );

CREATE TABLE platform.authorization_stream_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  high_watermark BIGINT NOT NULL DEFAULT 0 CHECK(high_watermark >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO platform.authorization_stream_state(singleton) VALUES(TRUE);

CREATE TABLE platform.authorization_event_log (
  stream_sequence BIGINT PRIMARY KEY CHECK(stream_sequence > 0),
  event_id UUID NOT NULL UNIQUE,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  aggregate_sequence BIGINT NOT NULL CHECK(aggregate_sequence > 0),
  event_type TEXT NOT NULL CHECK(event_type IN ('grant_delivered','revocation_epoch_changed')),
  occurred_at TIMESTAMPTZ NOT NULL,
  signing_payload BYTEA NOT NULL CHECK(octet_length(signing_payload) BETWEEN 32 AND 1048576),
  payload_digest CHAR(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  signing_key_revision TEXT NOT NULL,
  signature_algorithm TEXT NOT NULL CHECK(signature_algorithm='RS256'),
  signature BYTEA NOT NULL CHECK(octet_length(signature) BETWEEN 64 AND 1024),
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,aggregate_sequence)
);
CREATE INDEX authorization_event_retention_idx
  ON platform.authorization_event_log(created_at,stream_sequence);

CREATE TABLE platform.authorization_snapshot (
  snapshot_ref UUID PRIMARY KEY,
  high_watermark BIGINT NOT NULL CHECK(high_watermark >= 0),
  key_set_revision CHAR(64) NOT NULL CHECK(key_set_revision ~ '^[0-9a-f]{64}$'),
  frozen_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expires_at > frozen_at)
);
CREATE INDEX authorization_snapshot_expiry_idx ON platform.authorization_snapshot(expires_at);

CREATE TABLE platform.authorization_snapshot_record (
  snapshot_ref UUID NOT NULL REFERENCES platform.authorization_snapshot(snapshot_ref) ON DELETE CASCADE,
  ordinal BIGINT NOT NULL CHECK(ordinal >= 0),
  record_payload BYTEA NOT NULL CHECK(octet_length(record_payload) BETWEEN 1 AND 1048576),
  PRIMARY KEY(snapshot_ref,ordinal)
);

CREATE FUNCTION platform.reject_authorization_feed_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authorization feed records are immutable';
END;
$$;
REVOKE ALL ON FUNCTION platform.reject_authorization_feed_update() FROM PUBLIC;
CREATE TRIGGER authorization_event_immutable
BEFORE UPDATE ON platform.authorization_event_log
FOR EACH ROW EXECUTE FUNCTION platform.reject_authorization_feed_update();
CREATE TRIGGER authorization_snapshot_immutable
BEFORE UPDATE ON platform.authorization_snapshot
FOR EACH ROW EXECUTE FUNCTION platform.reject_authorization_feed_update();
CREATE TRIGGER authorization_snapshot_record_immutable
BEFORE UPDATE ON platform.authorization_snapshot_record
FOR EACH ROW EXECUTE FUNCTION platform.reject_authorization_feed_update();

REVOKE ALL ON
  platform.authorization_stream_state,
  platform.authorization_event_log,
  platform.authorization_snapshot,
  platform.authorization_snapshot_record
FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
