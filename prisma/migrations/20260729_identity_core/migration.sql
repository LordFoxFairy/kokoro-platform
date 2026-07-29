SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.command_receipt
  ALTER COLUMN command_id TYPE TEXT USING (
    CASE
      WHEN command_id::TEXT ~ '^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        THEN command_id::TEXT
      ELSE replace(command_id::TEXT,'-','')
    END
  );
ALTER TABLE platform.command_receipt
  ADD CONSTRAINT command_receipt_command_id_format CHECK (
    command_id ~ '^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$'
  );

ALTER TABLE platform.authorization_identity_session
  ADD COLUMN device_label TEXT NOT NULL
    CHECK(length(device_label) BETWEEN 1 AND 128),
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL;

CREATE TABLE platform.identity_account (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verification_pending','active','disabled','removed')),
  account_generation BIGINT NOT NULL DEFAULT 1 CHECK (account_generation > 0),
  security_epoch BIGINT NOT NULL DEFAULT 1 CHECK (security_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,account_ref),
  UNIQUE(site_ref,subject_ref),
  UNIQUE(site_ref,account_ref,subject_ref)
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

CREATE TABLE platform.identity_login_identifier (
  site_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK(generation > 0),
  kind TEXT NOT NULL CHECK(kind='email'),
  normalized_value TEXT NOT NULL CHECK(
    length(normalized_value) BETWEEN 3 AND 191
    AND normalized_value=lower(normalized_value)
  ),
  status TEXT NOT NULL CHECK(status IN ('pending_verification','active','retired')),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,account_ref,kind,generation),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  CHECK((status='active') = (verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX identity_login_identifier_current_value_idx
  ON platform.identity_login_identifier(site_ref,kind,normalized_value)
  WHERE status IN ('pending_verification','active');
CREATE UNIQUE INDEX identity_login_identifier_one_active_per_account_idx
  ON platform.identity_login_identifier(site_ref,account_ref,kind)
  WHERE status='active';

CREATE TABLE platform.identity_verification_transaction (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  transaction_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration','email_change','password_reset','account_recovery')),
  email_normalized TEXT NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 191
    AND email_normalized=lower(email_normalized)
  ),
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
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  CHECK (
    expires_at > created_at
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
  UNIQUE(workload_identity_id,site_ref,release_ref),
  ADD CONSTRAINT authorization_product_binding_workload_site
  UNIQUE(workload_identity_id,site_ref);

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

CREATE TABLE platform.identity_totp_authenticator (
  site_ref TEXT NOT NULL,
  authenticator_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
  secret_algorithm TEXT NOT NULL CHECK(secret_algorithm='A256GCM'),
  secret_key_revision TEXT NOT NULL CHECK(length(secret_key_revision) BETWEEN 1 AND 128),
  secret_nonce TEXT NOT NULL CHECK(length(secret_nonce) BETWEEN 16 AND 32),
  secret_ciphertext TEXT NOT NULL CHECK(length(secret_ciphertext) BETWEEN 16 AND 4096),
  secret_authentication_tag TEXT NOT NULL CHECK(length(secret_authentication_tag) BETWEEN 20 AND 32),
  last_accepted_timestep BIGINT CHECK(last_accepted_timestep IS NULL OR last_accepted_timestep >= 0),
  confirmed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,authenticator_ref),
  UNIQUE(site_ref,authenticator_ref,account_ref,subject_ref),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  CHECK(
    (state='pending' AND confirmed_at IS NULL AND revoked_at IS NULL)
    OR (state='active' AND confirmed_at IS NOT NULL AND revoked_at IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX identity_one_active_totp_authenticator_idx
  ON platform.identity_totp_authenticator(site_ref,account_ref)
  WHERE state='active';

CREATE TABLE platform.identity_recovery_code_set (
  site_ref TEXT NOT NULL,
  set_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  generation BIGINT NOT NULL CHECK(generation > 0),
  state TEXT NOT NULL CHECK(state IN ('active','replaced','revoked')),
  replaced_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,set_ref),
  UNIQUE(site_ref,set_ref,account_ref,subject_ref),
  UNIQUE(site_ref,account_ref,generation),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  CHECK(
    (state='active' AND replaced_at IS NULL AND revoked_at IS NULL)
    OR (state='replaced' AND replaced_at IS NOT NULL AND revoked_at IS NULL)
    OR (state='revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX identity_one_active_recovery_code_set_idx
  ON platform.identity_recovery_code_set(site_ref,account_ref)
  WHERE state='active';

CREATE TABLE platform.identity_recovery_code (
  site_ref TEXT NOT NULL,
  set_ref TEXT NOT NULL,
  code_digest CHAR(64) NOT NULL CHECK(code_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('active','used','revoked')),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,code_digest),
  FOREIGN KEY(site_ref,set_ref)
    REFERENCES platform.identity_recovery_code_set(site_ref,set_ref),
  CHECK((state='used') = (used_at IS NOT NULL))
);
CREATE INDEX identity_recovery_code_set_idx
  ON platform.identity_recovery_code(site_ref,set_ref,state);

CREATE TABLE platform.identity_auth_rate_limit (
  site_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('session_login','reauthentication')),
  window_started_at TIMESTAMPTZ NOT NULL,
  failed_attempt_count INTEGER NOT NULL CHECK(failed_attempt_count BETWEEN 0 AND 10),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,account_ref,purpose),
  FOREIGN KEY(site_ref,account_ref)
    REFERENCES platform.identity_account(site_ref,account_ref)
);

CREATE TABLE platform.identity_auth_transaction (
  site_ref TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  initiating_command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose='session_login'),
  challenge_kind TEXT NOT NULL CHECK(challenge_kind IN ('totp','recovery')),
  authenticator_ref TEXT,
  recovery_set_ref TEXT,
  password_credential_epoch BIGINT NOT NULL CHECK(password_credential_epoch > 0),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','expired','locked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts=5),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(site_ref,authenticator_ref,account_ref,subject_ref)
    REFERENCES platform.identity_totp_authenticator(site_ref,authenticator_ref,account_ref,subject_ref),
  FOREIGN KEY(site_ref,recovery_set_ref,account_ref,subject_ref)
    REFERENCES platform.identity_recovery_code_set(site_ref,set_ref,account_ref,subject_ref),
  CHECK(expires_at > created_at),
  CHECK((state='consumed') = (consumed_at IS NOT NULL)),
  CHECK(authenticator_ref IS NOT NULL OR recovery_set_ref IS NOT NULL),
  CHECK(
    (challenge_kind='totp' AND authenticator_ref IS NOT NULL)
    OR (challenge_kind='recovery' AND recovery_set_ref IS NOT NULL)
  )
);
CREATE INDEX identity_auth_transaction_pending_owner_idx
  ON platform.identity_auth_transaction(site_ref,account_ref,purpose)
  WHERE state='pending';
CREATE INDEX identity_auth_transaction_expiry_idx
  ON platform.identity_auth_transaction(expires_at)
  WHERE state='pending';

CREATE TABLE platform.identity_reauthentication_challenge (
  site_ref TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  initiating_command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  consuming_command_id TEXT UNIQUE REFERENCES platform.command_receipt(command_id),
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience='platform-public'),
  operation_id TEXT NOT NULL CHECK(operation_id IN ('beginTotpEnrollment','disableTotp','regenerateRecoveryCodes')),
  resource_kind TEXT NOT NULL CHECK(resource_kind='identity_account'),
  resource_ref TEXT NOT NULL,
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  session_epoch BIGINT NOT NULL CHECK(session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK(credential_epoch > 0),
  password_credential_epoch BIGINT NOT NULL CHECK(password_credential_epoch > 0),
  auth_strength_policy_revision TEXT NOT NULL CHECK(
    length(auth_strength_policy_revision) BETWEEN 1 AND 128
    AND auth_strength_policy_revision ~ '^[A-Za-z0-9_.-]+$'
  ),
  authenticator_ref TEXT NOT NULL,
  recovery_set_ref TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','expired','locked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts=5),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  FOREIGN KEY(site_ref,authenticator_ref,account_ref,subject_ref)
    REFERENCES platform.identity_totp_authenticator(site_ref,authenticator_ref,account_ref,subject_ref),
  FOREIGN KEY(site_ref,recovery_set_ref,account_ref,subject_ref)
    REFERENCES platform.identity_recovery_code_set(site_ref,set_ref,account_ref,subject_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK(resource_ref=account_ref),
  CHECK(expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  CHECK(
    (state='consumed' AND consumed_at IS NOT NULL AND consuming_command_id IS NOT NULL)
    OR (state<>'consumed' AND consumed_at IS NULL AND consuming_command_id IS NULL)
  )
);
CREATE UNIQUE INDEX identity_one_pending_reauthentication_challenge_idx
  ON platform.identity_reauthentication_challenge(site_ref,account_ref,session_ref,operation_id)
  WHERE state='pending';
CREATE INDEX identity_reauthentication_challenge_expiry_idx
  ON platform.identity_reauthentication_challenge(expires_at)
  WHERE state='pending';

CREATE TABLE platform.identity_totp_enrollment_transaction (
  site_ref TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  authenticator_ref TEXT NOT NULL,
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  session_epoch BIGINT NOT NULL CHECK(session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK(credential_epoch > 0),
  auth_strength_policy_revision TEXT NOT NULL CHECK(
    length(auth_strength_policy_revision) BETWEEN 1 AND 128
    AND auth_strength_policy_revision ~ '^[A-Za-z0-9_.-]+$'
  ),
  initiating_command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','expired','locked','superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts=5),
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,transaction_ref),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  FOREIGN KEY(site_ref,authenticator_ref,account_ref,subject_ref)
    REFERENCES platform.identity_totp_authenticator(site_ref,authenticator_ref,account_ref,subject_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK(expires_at > created_at),
  CHECK((state='confirmed') = (confirmed_at IS NOT NULL))
);
CREATE UNIQUE INDEX identity_one_pending_totp_enrollment_idx
  ON platform.identity_totp_enrollment_transaction(site_ref,account_ref)
  WHERE state='pending';
CREATE INDEX identity_totp_enrollment_expiry_idx
  ON platform.identity_totp_enrollment_transaction(expires_at)
  WHERE state='pending';

CREATE TABLE platform.identity_totp_enrollment_delivery_claim (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  session_epoch BIGINT NOT NULL CHECK(session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK(credential_epoch > 0),
  auth_strength_policy_revision TEXT NOT NULL CHECK(
    length(auth_strength_policy_revision) BETWEEN 1 AND 128
    AND auth_strength_policy_revision ~ '^[A-Za-z0-9_.-]+$'
  ),
  transaction_ref TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('first_claim_consumed','superseded')),
  claimed_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,transaction_ref)
    REFERENCES platform.identity_totp_enrollment_transaction(site_ref,transaction_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK(
    (state='first_claim_consumed' AND superseded_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE TABLE platform.identity_reauthentication_proof (
  proof_digest CHAR(64) PRIMARY KEY CHECK(proof_digest ~ '^[0-9a-f]{64}$'),
  issuing_command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience='platform-public'),
  operation_id TEXT NOT NULL CHECK(operation_id IN ('beginTotpEnrollment','disableTotp','regenerateRecoveryCodes')),
  resource_kind TEXT NOT NULL CHECK(resource_kind='identity_account'),
  resource_ref TEXT NOT NULL,
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  session_epoch BIGINT NOT NULL CHECK(session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK(credential_epoch > 0),
  auth_strength_policy_revision TEXT NOT NULL CHECK(length(auth_strength_policy_revision) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('active','consumed','revoked','superseded')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consuming_command_id TEXT REFERENCES platform.command_receipt(command_id),
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK(resource_ref=account_ref),
  CHECK(expires_at > issued_at AND expires_at-issued_at <= INTERVAL '5 minutes'),
  CHECK(
    (state='active' AND consumed_at IS NULL AND consuming_command_id IS NULL AND superseded_at IS NULL)
    OR (state='consumed' AND consumed_at IS NOT NULL AND consuming_command_id IS NOT NULL AND superseded_at IS NULL)
    OR (state='revoked' AND consumed_at IS NULL AND consuming_command_id IS NULL AND superseded_at IS NULL)
    OR (state='superseded' AND consumed_at IS NULL AND consuming_command_id IS NULL AND superseded_at IS NOT NULL)
  )
);
CREATE INDEX identity_reauthentication_proof_owner_idx
  ON platform.identity_reauthentication_proof(site_ref,account_ref,state,expires_at);

CREATE TABLE platform.identity_reauthentication_delivery_claim (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  proof_digest CHAR(64) NOT NULL UNIQUE REFERENCES platform.identity_reauthentication_proof(proof_digest),
  site_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('first_claim_consumed','superseded')),
  claimed_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  CHECK(
    (state='first_claim_consumed' AND superseded_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE TABLE platform.identity_recovery_code_delivery_claim (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  session_epoch BIGINT NOT NULL CHECK(session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK(credential_epoch > 0),
  auth_strength_policy_revision TEXT NOT NULL CHECK(
    length(auth_strength_policy_revision) BETWEEN 1 AND 128
    AND auth_strength_policy_revision ~ '^[A-Za-z0-9_.-]+$'
  ),
  set_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('confirmTotpEnrollment','regenerateRecoveryCodes')),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('first_claim_consumed','superseded')),
  claimed_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,set_ref,account_ref,subject_ref)
    REFERENCES platform.identity_recovery_code_set(site_ref,set_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK(
    (state='first_claim_consumed' AND superseded_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL)
  )
);

CREATE TABLE platform.identity_security_event (
  event_id UUID PRIMARY KEY REFERENCES platform.outbox_event(event_id),
  site_ref TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT,
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 128),
  account_security_epoch BIGINT NOT NULL CHECK(account_security_epoch > 0),
  payload_digest CHAR(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  correlation_id TEXT NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 128),
  causation_id TEXT NOT NULL REFERENCES platform.command_receipt(command_id),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,account_ref,subject_ref)
    REFERENCES platform.identity_account(site_ref,account_ref,subject_ref),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref)
);

CREATE FUNCTION platform.reject_identity_security_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'IDENTITY_SECURITY_EVENT_IMMUTABLE' USING ERRCODE='23000';
END $$;
REVOKE ALL ON FUNCTION platform.reject_identity_security_event_mutation() FROM PUBLIC;
CREATE TRIGGER identity_security_event_immutable
BEFORE UPDATE OR DELETE ON platform.identity_security_event
FOR EACH ROW EXECUTE FUNCTION platform.reject_identity_security_event_mutation();

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

CREATE TABLE platform.identity_session_delivery_claim (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('first_claim_consumed','superseded')),
  claimed_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(session_ref,subject_ref,site_ref)
    REFERENCES platform.authorization_identity_session(session_ref,subject_ref,site_ref),
  CHECK(
    (state='first_claim_consumed' AND superseded_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL)
  )
);
CREATE INDEX identity_session_delivery_owner_idx
  ON platform.identity_session_delivery_claim(site_ref,subject_ref,session_ref);

CREATE TABLE platform.identity_personal_workspace (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  workspace_ref TEXT NOT NULL,
  personal_owner_subject_ref TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK(kind='personal'),
  state TEXT NOT NULL CHECK(state IN ('active','disabled')),
  security_epoch BIGINT NOT NULL DEFAULT 1 CHECK(security_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,workspace_ref),
  UNIQUE(site_ref,personal_owner_subject_ref),
  FOREIGN KEY(personal_owner_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref)
);

CREATE TABLE platform.identity_workspace_membership (
  site_ref TEXT NOT NULL,
  workspace_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role='owner'),
  state TEXT NOT NULL CHECK(state='active'),
  membership_epoch BIGINT NOT NULL DEFAULT 1 CHECK(membership_epoch > 0),
  authorization_epoch BIGINT NOT NULL DEFAULT 1 CHECK(authorization_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,workspace_ref,subject_ref),
  FOREIGN KEY(site_ref,workspace_ref)
    REFERENCES platform.identity_personal_workspace(site_ref,workspace_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref)
);
CREATE UNIQUE INDEX identity_personal_workspace_one_owner_idx
  ON platform.identity_workspace_membership(site_ref,workspace_ref)
  WHERE state='active' AND role='owner';

CREATE TABLE platform.identity_execution_space (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  execution_space_ref TEXT NOT NULL,
  project_ref TEXT NOT NULL UNIQUE,
  execution_namespace TEXT NOT NULL UNIQUE CHECK(length(execution_namespace) BETWEEN 32 AND 128),
  state TEXT NOT NULL CHECK(state IN ('allocation_pending','active','failed','disabled')),
  security_epoch BIGINT NOT NULL DEFAULT 1 CHECK(security_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,execution_space_ref),
  UNIQUE(site_ref,execution_space_ref,execution_namespace),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref)
);

ALTER TABLE platform.authorization_project
  ADD CONSTRAINT authorization_project_execution_space_fk
  FOREIGN KEY(site_ref,execution_space_ref)
  REFERENCES platform.identity_execution_space(site_ref,execution_space_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.identity_namespace_allocation_intent (
  intent_ref UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  site_ref TEXT NOT NULL,
  execution_space_ref TEXT NOT NULL,
  execution_namespace TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','failed','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(site_ref,execution_space_ref,execution_namespace)
    REFERENCES platform.identity_execution_space(site_ref,execution_space_ref,execution_namespace)
);

CREATE TABLE platform.identity_personal_bootstrap (
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  bootstrap_kind TEXT NOT NULL CHECK(bootstrap_kind='personal_v1'),
  workspace_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  execution_space_ref TEXT NOT NULL,
  execution_namespace TEXT NOT NULL,
  namespace_intent_ref UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,subject_ref,subject_generation,bootstrap_kind),
  FOREIGN KEY(site_ref,workspace_ref)
    REFERENCES platform.identity_personal_workspace(site_ref,workspace_ref),
  FOREIGN KEY(site_ref,execution_space_ref,execution_namespace)
    REFERENCES platform.identity_execution_space(site_ref,execution_space_ref,execution_namespace),
  FOREIGN KEY(project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  FOREIGN KEY(namespace_intent_ref)
    REFERENCES platform.identity_namespace_allocation_intent(intent_ref),
  UNIQUE(site_ref,workspace_ref,billing_account_ref,project_ref,execution_space_ref)
);

CREATE TABLE platform.identity_receipt_recovery_capability (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  site_release_ref TEXT NOT NULL,
  site_project_binding_ref TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK(binding_epoch > 0),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 128),
  transaction_ref TEXT,
  capability_digest CHAR(64) NOT NULL CHECK(capability_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(workload_identity_id,site_ref,site_release_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref,release_ref),
  CHECK((state='consumed') = (consumed_at IS NOT NULL))
);
CREATE INDEX identity_receipt_recovery_expiry_idx
  ON platform.identity_receipt_recovery_capability(expires_at) WHERE state='active';

REVOKE ALL ON
  platform.identity_account,
  platform.identity_password_credential,
  platform.identity_login_identifier,
  platform.identity_verification_transaction,
  platform.identity_verification_legal_acceptance,
  platform.identity_verification_delivery,
  platform.identity_totp_authenticator,
  platform.identity_recovery_code_set,
  platform.identity_recovery_code,
  platform.identity_auth_rate_limit,
  platform.identity_auth_transaction,
  platform.identity_reauthentication_challenge,
  platform.identity_totp_enrollment_transaction,
  platform.identity_totp_enrollment_delivery_claim,
  platform.identity_reauthentication_proof,
  platform.identity_reauthentication_delivery_claim,
  platform.identity_recovery_code_delivery_claim,
  platform.identity_security_event,
  platform.identity_refresh_family,
  platform.identity_refresh_credential,
  platform.identity_session_delivery_claim,
  platform.identity_receipt_recovery_capability,
  platform.identity_personal_workspace,
  platform.identity_workspace_membership,
  platform.identity_execution_space,
  platform.identity_namespace_allocation_intent,
  platform.identity_personal_bootstrap
FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE platform_migrator IN SCHEMA platform
  REVOKE ALL ON TABLES FROM PUBLIC;
