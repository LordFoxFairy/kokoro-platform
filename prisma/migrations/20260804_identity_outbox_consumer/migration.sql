SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.identity_namespace_allocation_intent
  ADD COLUMN last_error_code TEXT,
  ADD CONSTRAINT identity_namespace_allocation_error_code_bounded
    CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128);

ALTER TABLE platform.identity_verification_delivery
  DROP CONSTRAINT identity_verification_delivery_state_check,
  DROP CONSTRAINT identity_verification_delivery_check,
  ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN superseded_at TIMESTAMPTZ,
  ADD CONSTRAINT identity_verification_delivery_credential_revision_valid
    CHECK(credential_revision BETWEEN 0 AND 20),
  ADD CONSTRAINT identity_verification_delivery_state_valid
    CHECK(state IN ('queued','dispatching','delivered','failed','superseded')),
  ADD CONSTRAINT identity_verification_delivery_outcome_valid CHECK (
    (state IN ('queued','dispatching') AND delivered_at IS NULL AND failed_at IS NULL AND superseded_at IS NULL)
    OR (state='delivered' AND delivered_at IS NOT NULL AND failed_at IS NULL AND superseded_at IS NULL)
    OR (state='failed' AND delivered_at IS NULL AND failed_at IS NOT NULL AND superseded_at IS NULL)
    OR (state='superseded' AND delivered_at IS NULL AND failed_at IS NULL AND superseded_at IS NOT NULL)
  ),
  ADD CONSTRAINT identity_verification_delivery_error_code_bounded
    CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128);
