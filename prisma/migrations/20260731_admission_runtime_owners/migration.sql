SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admission_launch_profile_snapshot (
  launch_profile_ref TEXT PRIMARY KEY
    CHECK(launch_profile_ref ~ '^launch-profile:sha256:[a-f0-9]{64}$'),
  site_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  snapshot_digest CHAR(64) NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_release_ref,site_ref),
  UNIQUE(launch_profile_ref,site_release_ref,site_ref),
  FOREIGN KEY(site_release_ref,site_ref)
    REFERENCES platform.site_release(release_ref,site_ref),
  CHECK(launch_profile_ref='launch-profile:sha256:'||snapshot_digest)
);

CREATE TABLE platform.admission_capability_catalog_snapshot (
  agent_catalog_ref TEXT PRIMARY KEY
    CHECK(agent_catalog_ref ~ '^agent-catalog:sha256:[a-f0-9]{64}$'),
  site_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  snapshot_digest CHAR(64) NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  published_at TIMESTAMPTZ NOT NULL,
  frozen_at TIMESTAMPTZ NOT NULL,
  signing_key_ref TEXT NOT NULL CHECK(length(signing_key_ref) BETWEEN 1 AND 256),
  signature_algorithm TEXT NOT NULL CHECK(signature_algorithm='ed25519-sha256-v1'),
  signature_payload_digest CHAR(64) NOT NULL
    CHECK(signature_payload_digest ~ '^[a-f0-9]{64}$'),
  signature BYTEA NOT NULL CHECK(octet_length(signature)=64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_release_ref,site_ref),
  UNIQUE(agent_catalog_ref,site_release_ref,site_ref),
  FOREIGN KEY(site_release_ref,site_ref)
    REFERENCES platform.site_release(release_ref,site_ref),
  CHECK(agent_catalog_ref='agent-catalog:sha256:'||snapshot_digest)
);

CREATE TABLE platform.capability_projection_command (
  site_id TEXT NOT NULL REFERENCES platform.site(site_ref),
  command_id TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('processing','committed')),
  agent_catalog_ref TEXT REFERENCES platform.admission_capability_catalog_snapshot(agent_catalog_ref),
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,command_id),
  UNIQUE(caller_identity,site_id,idempotency_key),
  CHECK((state='processing' AND agent_catalog_ref IS NULL) OR
        (state='committed' AND agent_catalog_ref IS NOT NULL))
);

CREATE FUNCTION platform.reject_admission_runtime_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ADMISSION_RUNTIME_SNAPSHOT_IMMUTABLE';
END;
$$;
REVOKE ALL ON FUNCTION platform.reject_admission_runtime_snapshot_mutation() FROM PUBLIC;

CREATE TRIGGER admission_launch_profile_immutable
BEFORE UPDATE OR DELETE ON platform.admission_launch_profile_snapshot
FOR EACH ROW EXECUTE FUNCTION platform.reject_admission_runtime_snapshot_mutation();

CREATE TRIGGER admission_capability_catalog_immutable
BEFORE UPDATE OR DELETE ON platform.admission_capability_catalog_snapshot
FOR EACH ROW EXECUTE FUNCTION platform.reject_admission_runtime_snapshot_mutation();

ALTER TABLE platform.admission_launch_profile_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_launch_profile_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_launch_profile_site_scope ON platform.admission_launch_profile_snapshot
  USING(site_ref=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),''));

ALTER TABLE platform.admission_capability_catalog_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_capability_catalog_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_capability_catalog_site_scope ON platform.admission_capability_catalog_snapshot
  USING(site_ref=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),''));

ALTER TABLE platform.capability_projection_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.capability_projection_command FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_projection_command_site_scope ON platform.capability_projection_command
  USING(site_id=NULLIF(current_setting('app.site_id',true),'') AND
        caller_identity=NULLIF(current_setting('app.caller_identity',true),''))
  WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),'') AND
             caller_identity=NULLIF(current_setting('app.caller_identity',true),''));

REVOKE ALL ON
  platform.admission_launch_profile_snapshot,
  platform.admission_capability_catalog_snapshot,
  platform.capability_projection_command
FROM PUBLIC;
