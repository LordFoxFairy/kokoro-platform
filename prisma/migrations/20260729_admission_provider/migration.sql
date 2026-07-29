SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admission_command (
  site_id TEXT NOT NULL CHECK (length(site_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL CHECK (operation IN (
    'prepare_run',
    'finalize_run_authorization',
    'release_run_authorization',
    'reconcile_run_authorization'
  )),
  command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  caller_identity TEXT NOT NULL CHECK (length(caller_identity) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 191),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','completed')),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  response_payload BYTEA,
  response_digest CHAR(64) CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, operation, command_id),
  UNIQUE (environment, caller_identity, site_id, operation, idempotency_key),
  CHECK (
    (state = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND response_payload IS NULL AND response_digest IS NULL)
    OR
    (state = 'completed' AND lease_token IS NULL AND lease_expires_at IS NULL
      AND response_payload IS NOT NULL AND response_digest IS NOT NULL
      AND octet_length(response_payload) BETWEEN 1 AND 1048576)
  )
);

CREATE INDEX admission_command_reclaim_idx
  ON platform.admission_command (lease_expires_at)
  WHERE state = 'processing';

ALTER TABLE platform.admission_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_command FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_command_site_caller_isolation ON platform.admission_command
  USING (
    site_id = current_setting('app.site_id', true)
    AND caller_identity = current_setting('app.caller_identity', true)
  )
  WITH CHECK (
    site_id = current_setting('app.site_id', true)
    AND caller_identity = current_setting('app.caller_identity', true)
  );

REVOKE ALL ON platform.admission_command FROM PUBLIC;
