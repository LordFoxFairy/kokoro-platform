SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.identity_account (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  email_normalized TEXT NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 191
    AND email_normalized = lower(email_normalized)
  ),
  state TEXT NOT NULL CHECK (state IN ('pending_verification','active','disabled','removed')),
  account_generation BIGINT NOT NULL DEFAULT 1 CHECK (account_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,account_ref),
  UNIQUE(site_ref,email_normalized),
  UNIQUE(site_ref,subject_ref),
  UNIQUE(site_ref,account_ref,subject_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref)
);

CREATE TABLE platform.identity_password_credential (
  site_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  password_hash TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  pepper_version INTEGER NOT NULL CHECK (pepper_version > 0),
  credential_epoch BIGINT NOT NULL DEFAULT 1 CHECK (credential_epoch > 0),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,account_ref),
  FOREIGN KEY(site_ref,account_ref)
    REFERENCES platform.identity_account(site_ref,account_ref) ON DELETE RESTRICT
);

CREATE TABLE platform.identity_verification_transaction (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  transaction_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration','email_change','password_reset','account_recovery')),
  email_normalized TEXT NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 191),
  pending_password_hash TEXT CHECK (pending_password_hash IS NULL OR pending_password_hash LIKE '$argon2id$%'),
  pending_pepper_version INTEGER CHECK (pending_pepper_version IS NULL OR pending_pepper_version > 0),
  secret_digest CHAR(64) NOT NULL CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed','expired','locked','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  resend_count INTEGER NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 20),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref),
  CHECK (
    (pending_password_hash IS NULL) = (pending_pepper_version IS NULL)
    AND expires_at > created_at
    AND ((state='consumed') = (consumed_at IS NOT NULL))
  )
);
CREATE INDEX identity_verification_email_idx
  ON platform.identity_verification_transaction(site_ref,email_normalized,created_at DESC);
CREATE UNIQUE INDEX identity_one_pending_verification_idx
  ON platform.identity_verification_transaction(site_ref,email_normalized,purpose)
  WHERE state='pending';

ALTER TABLE platform.authorization_product_binding
  ADD CONSTRAINT authorization_product_binding_workload_site_release
  UNIQUE(workload_identity_id,site_ref,release_ref);

CREATE TABLE platform.identity_verification_legal_acceptance (
  site_ref TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  term_ref TEXT NOT NULL CHECK (length(term_ref) BETWEEN 1 AND 128),
  accepted_at TIMESTAMPTZ NOT NULL,
  evidence_digest CHAR(64) NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  workload_identity_id TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref,term_ref),
  FOREIGN KEY(site_ref,transaction_ref)
    REFERENCES platform.identity_verification_transaction(site_ref,transaction_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref)
);

CREATE TABLE platform.identity_verification_delivery (
  site_ref TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  delivery_ref UUID NOT NULL,
  event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','delivered','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref,delivery_ref),
  FOREIGN KEY(site_ref,transaction_ref)
    REFERENCES platform.identity_verification_transaction(site_ref,transaction_ref),
  CHECK (
    (state='queued' AND delivered_at IS NULL AND failed_at IS NULL)
    OR (state='delivered' AND delivered_at IS NOT NULL AND failed_at IS NULL)
    OR (state='failed' AND delivered_at IS NULL AND failed_at IS NOT NULL)
  )
);

CREATE FUNCTION platform.reject_identity_legal_acceptance_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'IDENTITY_LEGAL_ACCEPTANCE_IMMUTABLE' USING ERRCODE='23000';
END $$;
REVOKE ALL ON FUNCTION platform.reject_identity_legal_acceptance_mutation() FROM PUBLIC;
CREATE TRIGGER verification_legal_acceptance_immutable
BEFORE UPDATE OR DELETE ON platform.identity_verification_legal_acceptance
FOR EACH ROW EXECUTE FUNCTION platform.reject_identity_legal_acceptance_mutation();

CREATE TABLE platform.identity_refresh_family (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  family_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','expired')),
  current_generation BIGINT NOT NULL DEFAULT 1 CHECK (current_generation > 0),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,family_ref),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  CHECK ((state='revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX identity_one_refresh_family_per_session_idx
  ON platform.identity_refresh_family(site_ref,session_ref)
  WHERE state='active';

CREATE TABLE platform.identity_refresh_credential (
  site_ref TEXT NOT NULL,
  family_ref TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK (generation > 0),
  credential_digest CHAR(64) NOT NULL CHECK (credential_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','consumed','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,credential_digest),
  UNIQUE(site_ref,family_ref,generation),
  FOREIGN KEY(site_ref,family_ref)
    REFERENCES platform.identity_refresh_family(site_ref,family_ref),
  CHECK ((state='consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX identity_refresh_family_history_idx
  ON platform.identity_refresh_credential(site_ref,family_ref,generation DESC);

REVOKE ALL ON
  platform.identity_account,
  platform.identity_password_credential,
  platform.identity_verification_transaction,
  platform.identity_verification_legal_acceptance,
  platform.identity_verification_delivery,
  platform.identity_refresh_family,
  platform.identity_refresh_credential
FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
