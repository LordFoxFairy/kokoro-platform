SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.commerce_command (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('anonymous','user','operator','workload')),
  actor_subject TEXT NOT NULL,
  authorization_subject_ref TEXT,
  actor_generation BIGINT NOT NULL CHECK (actor_generation > 0),
  command_version TEXT NOT NULL CHECK (length(command_version) BETWEEN 1 AND 64),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (actor_kind='user' AND authorization_subject_ref=actor_subject)
    OR (actor_kind<>'user' AND authorization_subject_ref IS NULL)
  ),
  FOREIGN KEY(authorization_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  UNIQUE(command_id,site_ref)
);
CREATE INDEX commerce_command_actor_idx ON platform.commerce_command(site_ref,actor_subject);

CREATE TABLE platform.commerce_billing_account (
  billing_account_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  state TEXT NOT NULL CHECK (state IN ('active','suspended','closed')),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(billing_account_ref,site_ref)
);
CREATE INDEX commerce_billing_account_site_idx
  ON platform.commerce_billing_account(site_ref,state);

CREATE TABLE platform.commerce_billing_account_membership (
  billing_account_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  membership_epoch BIGINT NOT NULL CHECK (membership_epoch > 0),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(billing_account_ref,subject_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref)
);
CREATE INDEX commerce_billing_membership_subject_idx
  ON platform.commerce_billing_account_membership(site_ref,subject_ref,state);
CREATE UNIQUE INDEX commerce_one_default_billing_account_idx
  ON platform.commerce_billing_account_membership(site_ref,subject_ref)
  WHERE state='active' AND is_default;

ALTER TABLE platform.identity_personal_bootstrap
  ADD CONSTRAINT identity_personal_bootstrap_billing_account_fk
  FOREIGN KEY(billing_account_ref,site_ref)
  REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref);

CREATE TABLE platform.commerce_catalog_product (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  product_ref TEXT NOT NULL CHECK(length(product_ref) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK(kind IN ('free','credit_pack','subscription','bundle')),
  state TEXT NOT NULL CHECK(state IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,product_ref)
);

CREATE TABLE platform.commerce_catalog_plan (
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  plan_ref TEXT NOT NULL CHECK(length(plan_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('active','disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,plan_ref)
);

CREATE TABLE platform.commerce_catalog_plan_version (
  plan_version_ref TEXT PRIMARY KEY CHECK(length(plan_version_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL,
  plan_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision > 0),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 160),
  term_action TEXT NOT NULL CHECK(term_action IN ('none','new_subscription','extend_from_max','reject_if_active')),
  term_seconds BIGINT CHECK(term_seconds IS NULL OR term_seconds > 0),
  stacking_scope TEXT NOT NULL CHECK(length(stacking_scope) BETWEEN 1 AND 128),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,plan_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(plan_version_ref,site_ref),
  FOREIGN KEY(site_ref,plan_ref) REFERENCES platform.commerce_catalog_plan(site_ref,plan_ref),
  CHECK((term_action='none' AND term_seconds IS NULL) OR (term_action<>'none' AND term_seconds IS NOT NULL))
);

CREATE TABLE platform.commerce_credit_program_revision (
  credit_program_revision_ref TEXT PRIMARY KEY CHECK(length(credit_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  bucket_class TEXT NOT NULL CHECK(bucket_class IN ('daily','period','permanent')),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  amount NUMERIC(38,0) NOT NULL CHECK(amount > 0),
  expires_after_seconds BIGINT CHECK(expires_after_seconds IS NULL OR expires_after_seconds > 0),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(credit_program_revision_ref,site_ref),
  CHECK(
    (bucket_class='permanent' AND expires_after_seconds IS NULL)
    OR (bucket_class IN ('daily','period') AND expires_after_seconds IS NOT NULL)
  )
);

CREATE TABLE platform.commerce_entitlement_template_revision (
  entitlement_template_revision_ref TEXT PRIMARY KEY CHECK(length(entitlement_template_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  template_ref TEXT NOT NULL CHECK(length(template_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  capability_key TEXT NOT NULL CHECK(capability_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 160),
  expires_after_seconds BIGINT CHECK(expires_after_seconds IS NULL OR expires_after_seconds > 0),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,template_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(entitlement_template_revision_ref,site_ref)
);

CREATE TABLE platform.commerce_fulfillment_program_revision (
  fulfillment_program_revision_ref TEXT PRIMARY KEY CHECK(length(fulfillment_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  output_plan_digest CHAR(64) NOT NULL CHECK(output_plan_digest ~ '^[a-f0-9]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,output_plan_digest),
  UNIQUE(fulfillment_program_revision_ref,site_ref)
);

CREATE TABLE platform.commerce_fulfillment_program_output (
  fulfillment_program_revision_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  output_line_id TEXT NOT NULL CHECK(length(output_line_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  cardinality INTEGER NOT NULL CHECK(cardinality BETWEEN 1 AND 100),
  output_kind TEXT NOT NULL CHECK(output_kind IN ('subscription_term','entitlement_grant','credit_grant')),
  plan_version_ref TEXT,
  entitlement_template_revision_ref TEXT,
  credit_program_revision_ref TEXT,
  PRIMARY KEY(fulfillment_program_revision_ref,output_line_id),
  UNIQUE(fulfillment_program_revision_ref,ordinal),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  FOREIGN KEY(entitlement_template_revision_ref,site_ref)
    REFERENCES platform.commerce_entitlement_template_revision(entitlement_template_revision_ref,site_ref),
  FOREIGN KEY(credit_program_revision_ref,site_ref)
    REFERENCES platform.commerce_credit_program_revision(credit_program_revision_ref,site_ref),
  CHECK(
    (output_kind='subscription_term' AND plan_version_ref IS NOT NULL AND entitlement_template_revision_ref IS NULL AND credit_program_revision_ref IS NULL)
    OR (output_kind='entitlement_grant' AND plan_version_ref IS NULL AND entitlement_template_revision_ref IS NOT NULL AND credit_program_revision_ref IS NULL)
    OR (output_kind='credit_grant' AND plan_version_ref IS NULL AND entitlement_template_revision_ref IS NULL AND credit_program_revision_ref IS NOT NULL)
  )
);
ALTER TABLE platform.commerce_fulfillment_program_output
  ADD CONSTRAINT commerce_subscription_term_cardinality_one
  CHECK(output_kind<>'subscription_term' OR cardinality=1);

CREATE TABLE platform.commerce_catalog_product_version (
  product_version_ref TEXT PRIMARY KEY CHECK(length(product_version_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL,
  product_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision > 0),
  safe_label TEXT NOT NULL CHECK(length(safe_label) BETWEEN 1 AND 160),
  plan_version_ref TEXT,
  fulfillment_program_revision_ref TEXT NOT NULL,
  legal_term_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK(cardinality(legal_term_refs) <= 16),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,product_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(product_version_ref,site_ref),
  FOREIGN KEY(site_ref,product_ref) REFERENCES platform.commerce_catalog_product(site_ref,product_ref),
  FOREIGN KEY(plan_version_ref,site_ref) REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref)
);

CREATE TABLE platform.commerce_redemption_program_revision (
  redemption_program_revision_ref TEXT PRIMARY KEY CHECK(length(redemption_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  product_version_ref TEXT NOT NULL,
  fulfillment_program_revision_ref TEXT NOT NULL,
  program_digest CHAR(64) NOT NULL CHECK(program_digest ~ '^[a-f0-9]{64}$'),
  max_redemptions_per_account INTEGER NOT NULL DEFAULT 1 CHECK(max_redemptions_per_account BETWEEN 1 AND 10000),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,program_digest),
  UNIQUE(redemption_program_revision_ref,site_ref),
  FOREIGN KEY(product_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_product_version(product_version_ref,site_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref)
);

CREATE TABLE platform.commerce_redemption_program_availability (
  site_ref TEXT NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','paused','retired')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  availability_epoch BIGINT NOT NULL DEFAULT 1 CHECK(availability_epoch > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,redemption_program_revision_ref),
  FOREIGN KEY(redemption_program_revision_ref,site_ref)
    REFERENCES platform.commerce_redemption_program_revision(redemption_program_revision_ref,site_ref),
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE platform.commerce_subscription (
  subscription_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  stacking_scope TEXT NOT NULL CHECK(length(stacking_scope) BETWEEN 1 AND 128),
  plan_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','expired','revoked')),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,billing_account_ref,stacking_scope),
  UNIQUE(subscription_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(site_ref,plan_ref) REFERENCES platform.commerce_catalog_plan(site_ref,plan_ref)
);

CREATE TABLE platform.commerce_subscription_term (
  subscription_term_ref UUID PRIMARY KEY,
  subscription_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  plan_version_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','admin_grant','program_window')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','reversed')),
  reversed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_type,source_ref,plan_version_ref),
  UNIQUE(subscription_term_ref,site_ref),
  FOREIGN KEY(subscription_ref,site_ref)
    REFERENCES platform.commerce_subscription(subscription_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  CHECK(ends_at > starts_at),
  CHECK((state='active' AND reversed_at IS NULL) OR (state='reversed' AND reversed_at IS NOT NULL))
);
CREATE INDEX commerce_subscription_term_account_end_idx
  ON platform.commerce_subscription_term(site_ref,billing_account_ref,ends_at DESC)
  WHERE state='active';

CREATE TABLE platform.commerce_code_batch (
  batch_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  code_lookup_key_revision TEXT NOT NULL CHECK(code_lookup_key_revision ~ '^[A-Za-z0-9_-]{1,64}$'),
  state TEXT NOT NULL CHECK(state IN ('draft','active','paused','retired')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  inventory_count INTEGER NOT NULL CHECK(inventory_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  UNIQUE(batch_ref,site_ref),
  UNIQUE(batch_ref,site_ref,code_lookup_key_revision),
  FOREIGN KEY(redemption_program_revision_ref,site_ref)
    REFERENCES platform.commerce_redemption_program_revision(redemption_program_revision_ref,site_ref),
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK((state='draft' AND activated_at IS NULL) OR (state<>'draft' AND activated_at IS NOT NULL))
);
CREATE INDEX commerce_code_batch_program_idx
  ON platform.commerce_code_batch(site_ref,redemption_program_revision_ref,state);

CREATE TABLE platform.commerce_redeem_code (
  code_ref UUID PRIMARY KEY,
  batch_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  code_lookup_key_revision TEXT NOT NULL CHECK(code_lookup_key_revision ~ '^[A-Za-z0-9_-]{1,64}$'),
  lookup_digest CHAR(64) NOT NULL CHECK(lookup_digest ~ '^[a-f0-9]{64}$'),
  safe_fingerprint TEXT NOT NULL CHECK(safe_fingerprint ~ '^[A-Z0-9-]{4,32}$'),
  state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','claimed','void')),
  claimed_by_command_id TEXT REFERENCES platform.commerce_command(command_id),
  claimed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,lookup_digest),
  UNIQUE(code_ref,site_ref),
  UNIQUE(code_ref,batch_ref,site_ref),
  FOREIGN KEY(batch_ref,site_ref,code_lookup_key_revision)
    REFERENCES platform.commerce_code_batch(batch_ref,site_ref,code_lookup_key_revision),
  CHECK(
    (state='available' AND claimed_by_command_id IS NULL AND claimed_at IS NULL AND voided_at IS NULL)
    OR (state='claimed' AND claimed_by_command_id IS NOT NULL AND claimed_at IS NOT NULL AND voided_at IS NULL)
    OR (state='void' AND claimed_by_command_id IS NULL AND claimed_at IS NULL AND voided_at IS NOT NULL)
  )
);
CREATE INDEX commerce_redeem_code_batch_state_idx
  ON platform.commerce_redeem_code(batch_ref,state);

CREATE TABLE platform.commerce_redemption (
  redemption_id UUID PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.commerce_command(command_id),
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  code_ref UUID NOT NULL UNIQUE,
  batch_ref UUID NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  product_version_ref TEXT NOT NULL,
  plan_version_ref TEXT,
  fulfillment_ref UUID UNIQUE,
  safe_code_fingerprint TEXT NOT NULL CHECK(safe_code_fingerprint ~ '^[A-Z0-9-]{4,32}$'),
  state TEXT NOT NULL CHECK(state IN ('executing','fulfilled','reversed','reconciliation_required')),
  redeemed_at TIMESTAMPTZ,
  state_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(redemption_id,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(code_ref,batch_ref,site_ref)
    REFERENCES platform.commerce_redeem_code(code_ref,batch_ref,site_ref),
  FOREIGN KEY(redemption_program_revision_ref,site_ref)
    REFERENCES platform.commerce_redemption_program_revision(redemption_program_revision_ref,site_ref),
  FOREIGN KEY(product_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_product_version(product_version_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  CHECK(
    (state='executing' AND redeemed_at IS NULL)
    OR (state<>'executing' AND redeemed_at IS NOT NULL)
  )
);
CREATE INDEX commerce_redemption_account_program_idx
  ON platform.commerce_redemption(site_ref,billing_account_ref,redemption_program_revision_ref,state);

CREATE TABLE platform.commerce_redemption_preview (
  preview_ref UUID PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.commerce_command(command_id),
  site_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  billing_account_ref TEXT NOT NULL,
  code_ref UUID NOT NULL,
  batch_ref UUID NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  product_version_ref TEXT NOT NULL,
  plan_version_ref TEXT,
  fulfillment_program_revision_ref TEXT NOT NULL,
  product_revision_digest CHAR(64) NOT NULL CHECK(product_revision_digest ~ '^[a-f0-9]{64}$'),
  program_digest CHAR(64) NOT NULL CHECK(program_digest ~ '^[a-f0-9]{64}$'),
  output_plan_digest CHAR(64) NOT NULL CHECK(output_plan_digest ~ '^[a-f0-9]{64}$'),
  preview_digest CHAR(64) NOT NULL CHECK(preview_digest ~ '^[a-f0-9]{64}$'),
  credential_key_revision TEXT NOT NULL CHECK(credential_key_revision ~ '^[A-Za-z0-9_-]{1,64}$'),
  credential_digest CHAR(64) NOT NULL CHECK(credential_digest ~ '^[a-f0-9]{64}$'),
  safe_terms JSONB NOT NULL CHECK(jsonb_typeof(safe_terms)='object'),
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','consumed','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_by_command_id TEXT REFERENCES platform.commerce_command(command_id),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(preview_ref,site_ref),
  FOREIGN KEY(subject_ref,site_ref) REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(code_ref,batch_ref,site_ref) REFERENCES platform.commerce_redeem_code(code_ref,batch_ref,site_ref),
  FOREIGN KEY(redemption_program_revision_ref,site_ref)
    REFERENCES platform.commerce_redemption_program_revision(redemption_program_revision_ref,site_ref),
  FOREIGN KEY(product_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_product_version(product_version_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref),
  CHECK(expires_at > created_at),
  CHECK(
    (state='live' AND consumed_by_command_id IS NULL AND consumed_at IS NULL)
    OR (state='consumed' AND consumed_by_command_id IS NOT NULL AND consumed_at IS NOT NULL)
    OR (state='expired' AND consumed_by_command_id IS NULL AND consumed_at IS NULL)
  )
);
CREATE INDEX commerce_redemption_preview_expiry_idx
  ON platform.commerce_redemption_preview(expires_at) WHERE state='live';

CREATE TABLE platform.commerce_fulfillment_transaction (
  fulfillment_id UUID PRIMARY KEY,
  command_id TEXT,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  billing_account_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('redemption','admin_grant','program_window')),
  source_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  cycle_key TEXT NOT NULL,
  product_version_ref TEXT NOT NULL,
  plan_version_ref TEXT,
  offering_version_ref TEXT NOT NULL,
  fulfillment_program_version_ref TEXT NOT NULL,
  output_plan_digest CHAR(64) NOT NULL CHECK (output_plan_digest ~ '^[a-f0-9]{64}$'),
  output_set_digest CHAR(64) CHECK (output_set_digest IS NULL OR output_set_digest ~ '^[a-f0-9]{64}$'),
  result_digest CHAR(64) CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_type,source_id,purpose,cycle_key),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  CHECK (
    (status='running' AND output_set_digest IS NULL AND result_digest IS NULL AND completed_at IS NULL)
    OR (status IN ('succeeded','failed') AND output_set_digest IS NOT NULL AND result_digest IS NOT NULL AND completed_at IS NOT NULL)
  )
);
CREATE INDEX commerce_fulfillment_account_idx
  ON platform.commerce_fulfillment_transaction(site_ref,billing_account_ref);

CREATE TABLE platform.commerce_fulfillment_output_plan (
  fulfillment_id UUID NOT NULL REFERENCES platform.commerce_fulfillment_transaction(fulfillment_id),
  output_line_id TEXT NOT NULL CHECK (length(output_line_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  cardinality INTEGER NOT NULL CHECK (cardinality BETWEEN 0 AND 100),
  template_revision TEXT NOT NULL CHECK (length(template_revision) BETWEEN 1 AND 256),
  output_kind TEXT NOT NULL CHECK (output_kind IN ('subscription','subscription_term','entitlement_grant','credit_grant')),
  disposition TEXT NOT NULL CHECK (disposition IN ('required','optional','forbidden')),
  PRIMARY KEY(fulfillment_id,output_line_id),
  UNIQUE(fulfillment_id,ordinal),
  UNIQUE(fulfillment_id,output_line_id,cardinality,template_revision,output_kind),
  CHECK (
    (disposition='forbidden' AND cardinality=0)
    OR (disposition IN ('required','optional') AND cardinality > 0)
  )
);

CREATE TABLE platform.commerce_fulfillment_actual_output (
  fulfillment_id UUID NOT NULL,
  output_line_id TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  cardinality INTEGER NOT NULL,
  template_revision TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  output_ref TEXT NOT NULL CHECK (length(output_ref) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(fulfillment_id,output_line_id,occurrence),
  UNIQUE(fulfillment_id,output_kind,output_ref),
  CHECK (occurrence BETWEEN 1 AND cardinality),
  FOREIGN KEY(fulfillment_id,output_line_id,cardinality,template_revision,output_kind)
    REFERENCES platform.commerce_fulfillment_output_plan(
      fulfillment_id,output_line_id,cardinality,template_revision,output_kind
    )
);

CREATE TABLE platform.commerce_command_outbox (
  command_id TEXT NOT NULL REFERENCES platform.commerce_command(command_id),
  event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  PRIMARY KEY(command_id,event_id)
);

CREATE TABLE platform.commerce_audit_entry (
  audit_id UUID PRIMARY KEY,
  command_id TEXT NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 128),
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref)
);
CREATE INDEX commerce_audit_site_time_idx
  ON platform.commerce_audit_entry(site_ref,occurred_at);

CREATE FUNCTION platform.reject_commerce_immutable_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'COMMERCE_IMMUTABLE_FACT' USING ERRCODE='23000';
END $$;

CREATE FUNCTION platform.assert_commerce_output_plan_contiguous() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  line_count INTEGER;
  min_ordinal INTEGER;
  max_ordinal INTEGER;
BEGIN
  SELECT count(*),min(ordinal),max(ordinal)
    INTO line_count,min_ordinal,max_ordinal
  FROM platform.commerce_fulfillment_output_plan
  WHERE fulfillment_id=NEW.fulfillment_id;
  IF line_count < 1 OR min_ordinal <> 0 OR max_ordinal <> line_count-1 THEN
    RAISE EXCEPTION 'OUTPUT_ORDINAL_NOT_CONTINUOUS' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.guard_commerce_command_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.command_id,OLD.site_ref,OLD.actor_kind,OLD.actor_subject,OLD.authorization_subject_ref,
         OLD.actor_generation,OLD.command_version,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.command_id,NEW.site_ref,NEW.actor_kind,NEW.actor_subject,NEW.authorization_subject_ref,
         NEW.actor_generation,NEW.command_version,NEW.created_at)
     OR OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'COMMERCE_COMMAND_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_commerce_fulfillment_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'running' OR NEW.output_set_digest IS NOT NULL OR NEW.result_digest IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'FULFILLMENT_INITIAL_STATE_INVALID' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' OR NEW.status NOT IN ('succeeded','failed') THEN
    RAISE EXCEPTION 'FULFILLMENT_STATUS_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF ROW(OLD.command_id,OLD.site_ref,OLD.billing_account_ref,OLD.source_type,OLD.source_id,OLD.purpose,
         OLD.cycle_key,OLD.product_version_ref,OLD.plan_version_ref,OLD.offering_version_ref,
         OLD.fulfillment_program_version_ref,OLD.output_plan_digest)
     IS DISTINCT FROM
     ROW(NEW.command_id,NEW.site_ref,NEW.billing_account_ref,NEW.source_type,NEW.source_id,NEW.purpose,
         NEW.cycle_key,NEW.product_version_ref,NEW.plan_version_ref,NEW.offering_version_ref,
         NEW.fulfillment_program_version_ref,NEW.output_plan_digest) THEN
    RAISE EXCEPTION 'FULFILLMENT_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.status='succeeded' AND (
    NOT EXISTS (
      SELECT 1 FROM platform.commerce_fulfillment_output_plan
      WHERE fulfillment_id=NEW.fulfillment_id
    ) OR EXISTS (
    SELECT 1
    FROM platform.commerce_fulfillment_output_plan expected
    LEFT JOIN LATERAL (
      SELECT count(*)::INTEGER AS actual_count
      FROM platform.commerce_fulfillment_actual_output actual
      WHERE actual.fulfillment_id=expected.fulfillment_id
        AND actual.output_line_id=expected.output_line_id
    ) actual ON TRUE
    WHERE expected.fulfillment_id=NEW.fulfillment_id
      AND (
        (expected.disposition='required' AND actual.actual_count<>expected.cardinality)
        OR (expected.disposition='optional' AND actual.actual_count>expected.cardinality)
        OR (expected.disposition='forbidden' AND actual.actual_count<>0)
      )
    )
  ) THEN
    RAISE EXCEPTION 'FULFILLMENT_OUTPUT_SET_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_commerce_code_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.code_ref,OLD.batch_ref,OLD.site_ref,OLD.code_lookup_key_revision,OLD.lookup_digest,
         OLD.safe_fingerprint,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.code_ref,NEW.batch_ref,NEW.site_ref,NEW.code_lookup_key_revision,NEW.lookup_digest,
         NEW.safe_fingerprint,NEW.created_at) THEN
    RAISE EXCEPTION 'REDEEM_CODE_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF OLD.state <> 'available' OR NEW.state NOT IN ('claimed','void') THEN
    RAISE EXCEPTION 'REDEEM_CODE_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_commerce_preview_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.preview_ref,OLD.command_id,OLD.site_ref,OLD.subject_ref,OLD.subject_generation,
         OLD.billing_account_ref,OLD.code_ref,OLD.batch_ref,OLD.redemption_program_revision_ref,
         OLD.product_version_ref,OLD.plan_version_ref,OLD.fulfillment_program_revision_ref,
         OLD.product_revision_digest,OLD.program_digest,OLD.output_plan_digest,OLD.preview_digest,
         OLD.credential_key_revision,OLD.credential_digest,OLD.safe_terms,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.preview_ref,NEW.command_id,NEW.site_ref,NEW.subject_ref,NEW.subject_generation,
         NEW.billing_account_ref,NEW.code_ref,NEW.batch_ref,NEW.redemption_program_revision_ref,
         NEW.product_version_ref,NEW.plan_version_ref,NEW.fulfillment_program_revision_ref,
         NEW.product_revision_digest,NEW.program_digest,NEW.output_plan_digest,NEW.preview_digest,
         NEW.credential_key_revision,NEW.credential_digest,NEW.safe_terms,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'REDEMPTION_PREVIEW_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF OLD.state <> 'live' OR NEW.state NOT IN ('consumed','expired') THEN
    RAISE EXCEPTION 'REDEMPTION_PREVIEW_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commerce_output_plan_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_output_plan
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_actual_output_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_actual_output
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_plan_version_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_catalog_plan_version
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_credit_program_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_credit_program_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_entitlement_template_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_entitlement_template_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_fulfillment_program_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_program_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_fulfillment_program_output_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_program_output
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_product_version_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_catalog_product_version
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_redemption_program_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_redemption_program_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_command_outbox_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_command_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_audit_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_audit_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE CONSTRAINT TRIGGER commerce_output_plan_contiguous
  AFTER INSERT ON platform.commerce_fulfillment_output_plan
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_commerce_output_plan_contiguous();
CREATE TRIGGER commerce_command_update_guard
  BEFORE UPDATE ON platform.commerce_command
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_command_update();
CREATE TRIGGER commerce_fulfillment_transition
  BEFORE INSERT OR UPDATE ON platform.commerce_fulfillment_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_fulfillment_transition();
CREATE TRIGGER commerce_code_transition
  BEFORE UPDATE ON platform.commerce_redeem_code
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_code_transition();
CREATE TRIGGER commerce_preview_transition
  BEFORE UPDATE ON platform.commerce_redemption_preview
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_preview_transition();

REVOKE ALL ON
  platform.commerce_command,
  platform.commerce_billing_account,
  platform.commerce_billing_account_membership,
  platform.commerce_catalog_product,
  platform.commerce_catalog_plan,
  platform.commerce_catalog_plan_version,
  platform.commerce_credit_program_revision,
  platform.commerce_entitlement_template_revision,
  platform.commerce_fulfillment_program_revision,
  platform.commerce_fulfillment_program_output,
  platform.commerce_catalog_product_version,
  platform.commerce_redemption_program_revision,
  platform.commerce_redemption_program_availability,
  platform.commerce_subscription,
  platform.commerce_subscription_term,
  platform.commerce_code_batch,
  platform.commerce_redeem_code,
  platform.commerce_redemption,
  platform.commerce_redemption_preview,
  platform.commerce_fulfillment_transaction,
  platform.commerce_fulfillment_output_plan,
  platform.commerce_fulfillment_actual_output,
  platform.commerce_command_outbox,
  platform.commerce_audit_entry
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_commerce_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_commerce_output_plan_contiguous() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_command_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_fulfillment_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_code_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_preview_transition() FROM PUBLIC;
