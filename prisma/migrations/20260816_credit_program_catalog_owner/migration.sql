CREATE TABLE platform.credit_program_catalog_snapshot (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  current_epoch NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK(current_epoch>=0),
  snapshot_digest TEXT NOT NULL CHECK(snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO platform.credit_program_catalog_snapshot(singleton,snapshot_digest)
VALUES (TRUE,'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

CREATE TABLE platform.credit_program_catalog_snapshot_revision (
  epoch NUMERIC(20,0) PRIMARY KEY CHECK(epoch>=0),
  snapshot_ref TEXT NOT NULL UNIQUE,
  snapshot_digest TEXT NOT NULL CHECK(snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL
);
INSERT INTO platform.credit_program_catalog_snapshot_revision(epoch,snapshot_ref,snapshot_digest,recorded_at)
VALUES (0,'credit-program-snapshot:0','sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '-infinity'::timestamptz);

CREATE TABLE platform.credit_program_head (
  program_ref TEXT PRIMARY KEY CHECK(program_ref ~ '^credit-program:[a-z][a-z0-9._-]{1,127}$'),
  current_revision NUMERIC(20,0) NOT NULL DEFAULT 0 CHECK(current_revision>=0),
  current_digest TEXT CHECK(current_digest IS NULL OR current_digest ~ '^sha256:[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK((current_revision=0 AND current_digest IS NULL) OR (current_revision>0 AND current_digest IS NOT NULL))
);

CREATE TABLE platform.credit_program_revision (
  program_ref TEXT NOT NULL REFERENCES platform.credit_program_head(program_ref),
  revision NUMERIC(20,0) NOT NULL CHECK(revision>0),
  revision_digest TEXT NOT NULL CHECK(revision_digest ~ '^sha256:[0-9a-f]{64}$'),
  exposure TEXT NOT NULL DEFAULT 'inert' CHECK(exposure='inert'),
  unit TEXT NOT NULL CHECK(unit ~ '^[a-z][a-z0-9._-]{0,63}$'),
  maximum_program_balance_per_account_minor NUMERIC(20,0) NOT NULL
    CHECK(maximum_program_balance_per_account_minor>0),
  reservation_ttl_seconds NUMERIC(20,0) NOT NULL CHECK(reservation_ttl_seconds>0),
  reconciliation_grace_seconds NUMERIC(20,0) NOT NULL CHECK(reconciliation_grace_seconds>=reservation_ttl_seconds),
  allow_negative_balance BOOLEAN NOT NULL DEFAULT FALSE CHECK(NOT allow_negative_balance),
  accounting_policy_ref TEXT NOT NULL CHECK(length(accounting_policy_ref) BETWEEN 3 AND 256),
  definition_bytes BYTEA NOT NULL CHECK(octet_length(definition_bytes)>0),
  catalog_epoch NUMERIC(20,0) NOT NULL UNIQUE CHECK(catalog_epoch>0),
  published_by TEXT NOT NULL CHECK(length(published_by) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  published_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(program_ref,revision),
  UNIQUE(program_ref,revision,revision_digest)
);

CREATE TABLE platform.credit_program_grant_rule (
  program_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('daily','period','permanent')),
  amount_minor NUMERIC(20,0) NOT NULL CHECK(amount_minor>0),
  burn_priority INTEGER NOT NULL CHECK(burn_priority BETWEEN 1 AND 1000),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 3 AND 256),
  scope_policy JSONB NOT NULL,
  window_policy JSONB NOT NULL,
  PRIMARY KEY(program_ref,revision,bucket),
  FOREIGN KEY(program_ref,revision) REFERENCES platform.credit_program_revision(program_ref,revision)
);

CREATE INDEX credit_program_revision_catalog_page
  ON platform.credit_program_revision(catalog_epoch,program_ref,revision);

CREATE TABLE platform.credit_program_publication_audit (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  program_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL,
  revision_digest TEXT NOT NULL,
  expected_version NUMERIC(20,0) NOT NULL,
  actor_subject_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  reason TEXT NOT NULL,
  replayed BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(program_ref,revision,revision_digest)
    REFERENCES platform.credit_program_revision(program_ref,revision,revision_digest)
);

CREATE TABLE platform.credit_program_outbox (
  event_ref UUID PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type='credit.program.revision-published.v1'),
  program_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL,
  revision_digest TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(delivery_state IN ('pending','delivering','delivered','dead_letter')),
  delivery_owner_ref TEXT,
  delivery_fence NUMERIC(20,0) NOT NULL DEFAULT 0,
  delivery_lease_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_error_code TEXT,
  last_error_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  UNIQUE(program_ref,revision),
  CHECK((delivery_state='dead_letter' AND dead_lettered_at IS NOT NULL) OR
        (delivery_state<>'dead_letter' AND dead_lettered_at IS NULL)),
  FOREIGN KEY(program_ref,revision,revision_digest)
    REFERENCES platform.credit_program_revision(program_ref,revision,revision_digest)
);

CREATE TRIGGER credit_program_revision_immutable BEFORE UPDATE OR DELETE
  ON platform.credit_program_revision FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_mutation();
CREATE TRIGGER credit_program_rule_immutable BEFORE UPDATE OR DELETE
  ON platform.credit_program_grant_rule FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_mutation();
CREATE TRIGGER credit_program_snapshot_revision_immutable BEFORE UPDATE OR DELETE
  ON platform.credit_program_catalog_snapshot_revision FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_mutation();
CREATE TRIGGER credit_program_audit_immutable BEFORE UPDATE OR DELETE
  ON platform.credit_program_publication_audit FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_mutation();
