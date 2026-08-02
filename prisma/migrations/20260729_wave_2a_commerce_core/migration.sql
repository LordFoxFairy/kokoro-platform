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

CREATE TABLE platform.commerce_catalog_epoch_authority (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  current_epoch BIGINT NOT NULL CHECK(current_epoch >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO platform.commerce_catalog_epoch_authority(singleton,current_epoch)
VALUES (TRUE,0);

-- Unicode 17.0 UnicodeData General_Category=Cf. PostgreSQL's POSIX regular
-- expressions do not expose Unicode general categories, so this authority
-- enumerates Cc/Cf/Zl/Zp and boundary Zs code points explicitly.
CREATE FUNCTION platform.commerce_safe_label_is_valid(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path=pg_catalog AS $$
  SELECT char_length(value) BETWEEN 1 AND 160
    AND value IS NFC NORMALIZED
    AND NOT EXISTS (
      SELECT 1
      FROM generate_series(1,char_length(value)) AS point(point_index)
      CROSS JOIN LATERAL (
        SELECT ascii(substr(value,point.point_index,1)) AS code_point
      ) AS scalar
      WHERE
        scalar.code_point BETWEEN 0 AND 31
        OR scalar.code_point BETWEEN 127 AND 159
        OR scalar.code_point IN (173,1564,1757,1807,2274,6158,65279,69821,69837,917505)
        OR scalar.code_point BETWEEN 1536 AND 1541
        OR scalar.code_point BETWEEN 2192 AND 2193
        OR scalar.code_point BETWEEN 8203 AND 8207
        OR scalar.code_point BETWEEN 8232 AND 8238
        OR scalar.code_point BETWEEN 8288 AND 8292
        OR scalar.code_point BETWEEN 8294 AND 8303
        OR scalar.code_point BETWEEN 65529 AND 65531
        OR scalar.code_point BETWEEN 78896 AND 78911
        OR scalar.code_point BETWEEN 113824 AND 113827
        OR scalar.code_point BETWEEN 119155 AND 119162
        OR scalar.code_point BETWEEN 917536 AND 917631
        OR (
          point.point_index IN (1,char_length(value))
          AND (
            scalar.code_point IN (32,160,5760,8239,8287,12288)
            OR scalar.code_point BETWEEN 8192 AND 8202
          )
        )
    )
$$;

CREATE FUNCTION platform.commerce_iana_zone_is_valid(zone TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE PARALLEL RESTRICTED STRICT SET search_path=pg_catalog AS $$
  SELECT char_length(zone) BETWEEN 1 AND 64
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone
    )
$$;

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
  safe_label TEXT NOT NULL CHECK(platform.commerce_safe_label_is_valid(safe_label)),
  term_action TEXT NOT NULL CHECK(term_action IN ('none','new_subscription','extend_from_max','reject_if_active')),
  term_seconds BIGINT CHECK(term_seconds IS NULL OR term_seconds > 0),
  stacking_scope TEXT NOT NULL CHECK(length(stacking_scope) BETWEEN 1 AND 128),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,plan_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(plan_version_ref,site_ref),
  FOREIGN KEY(site_ref,plan_ref) REFERENCES platform.commerce_catalog_plan(site_ref,plan_ref),
  CHECK((term_action='none' AND term_seconds IS NULL) OR (term_action<>'none' AND term_seconds IS NOT NULL))
);

CREATE FUNCTION platform.valid_credit_scope_policy(policy JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE STRICT SET search_path=pg_catalog,platform AS $$
DECLARE
  item JSONB;
BEGIN
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
     OR policy - ARRAY['version','surfaceRefs','capabilityKeys','agentRefs','allowUnattributedAgent']::TEXT[]
          IS DISTINCT FROM '{}'::JSONB
     OR policy->'version' IS DISTINCT FROM '1'::JSONB
     OR jsonb_typeof(policy->'surfaceRefs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(policy->'capabilityKeys') IS DISTINCT FROM 'array'
     OR jsonb_typeof(policy->'agentRefs') IS DISTINCT FROM 'array'
     OR jsonb_typeof(policy->'allowUnattributedAgent') IS DISTINCT FROM 'boolean'
     OR jsonb_array_length(policy->'surfaceRefs') NOT BETWEEN 1 AND 256
     OR jsonb_array_length(policy->'capabilityKeys') NOT BETWEEN 1 AND 256
     OR jsonb_array_length(policy->'agentRefs') > 256 THEN
    RETURN FALSE;
  END IF;
  FOR item IN
    SELECT value FROM jsonb_array_elements(
      (policy->'surfaceRefs') || (policy->'capabilityKeys') || (policy->'agentRefs')
    )
  LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string'
       OR length(item #>> '{}') NOT BETWEEN 1 AND 256 THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'surfaceRefs') value
    WHERE value !~ '^[a-z0-9][a-z0-9._:-]{0,255}$'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'capabilityKeys') value
    WHERE value !~ '^[a-z0-9][a-z0-9._:-]{0,255}$'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'agentRefs') value
    WHERE value !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'surfaceRefs') value GROUP BY value HAVING count(*)>1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'capabilityKeys') value GROUP BY value HAVING count(*)>1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(policy->'agentRefs') value GROUP BY value HAVING count(*)>1
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END $$;

CREATE TABLE platform.commerce_credit_program_revision (
  credit_program_revision_ref TEXT PRIMARY KEY CHECK(length(credit_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  ux_bucket_class TEXT NOT NULL CHECK(ux_bucket_class IN ('daily','period','permanent')),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  amount NUMERIC(38,0) NOT NULL CHECK(amount > 0),
  burn_priority INTEGER NOT NULL DEFAULT 1000,
  scope_policy JSONB NOT NULL CHECK(platform.valid_credit_scope_policy(scope_policy)),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  window_kind TEXT NOT NULL CHECK(window_kind IN ('none','daily','period')),
  rollover_policy TEXT NOT NULL CHECK(rollover_policy='none'),
  calendar_zone TEXT CHECK(calendar_zone IS NULL OR platform.commerce_iana_zone_is_valid(calendar_zone)),
  window_anchor TEXT CHECK(window_anchor IS NULL OR length(window_anchor) BETWEEN 1 AND 128),
  expires_after_seconds BIGINT CHECK(expires_after_seconds IS NULL OR expires_after_seconds > 0),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(credit_program_revision_ref,site_ref),
  UNIQUE(credit_program_revision_ref,site_ref,revision,revision_digest),
  CHECK(
    (ux_bucket_class='permanent' AND window_kind='none'
      AND calendar_zone IS NULL AND window_anchor IS NULL AND expires_after_seconds IS NULL)
    OR (ux_bucket_class='daily' AND window_kind='daily'
      AND calendar_zone IS NOT NULL
      AND window_anchor ~ '^daily@([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$'
      AND expires_after_seconds IS NULL)
    OR (ux_bucket_class='period' AND window_kind='period'
      AND calendar_zone IS NOT NULL AND window_anchor='subscription-term-start')
  )
);
CREATE INDEX commerce_credit_program_catalog_page_idx
  ON platform.commerce_credit_program_revision(site_ref,credit_program_revision_ref,catalog_epoch);

CREATE TABLE platform.commerce_entitlement_template_revision (
  entitlement_template_revision_ref TEXT PRIMARY KEY CHECK(length(entitlement_template_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  template_ref TEXT NOT NULL CHECK(length(template_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  capability_key TEXT NOT NULL CHECK(capability_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  safe_label TEXT NOT NULL CHECK(platform.commerce_safe_label_is_valid(safe_label)),
  expires_after_seconds BIGINT CHECK(expires_after_seconds IS NULL OR expires_after_seconds > 0),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,template_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(entitlement_template_revision_ref,site_ref)
);
CREATE INDEX commerce_entitlement_template_catalog_page_idx
  ON platform.commerce_entitlement_template_revision(site_ref,entitlement_template_revision_ref,catalog_epoch);

CREATE TABLE platform.commerce_fulfillment_program_revision (
  fulfillment_program_revision_ref TEXT PRIMARY KEY CHECK(length(fulfillment_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  output_plan_digest CHAR(64) NOT NULL CHECK(output_plan_digest ~ '^[a-f0-9]{64}$'),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,output_plan_digest),
  UNIQUE(fulfillment_program_revision_ref,site_ref),
  UNIQUE(fulfillment_program_revision_ref,site_ref,revision,output_plan_digest)
);

CREATE TABLE platform.commerce_fulfillment_program_output (
  fulfillment_program_revision_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  output_line_id TEXT NOT NULL CHECK(length(output_line_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 32),
  cardinality INTEGER NOT NULL CHECK(cardinality BETWEEN 1 AND 32),
  output_kind TEXT NOT NULL CHECK(output_kind IN ('subscription_term','entitlement_grant','credit_grant','credit_program_enrollment')),
  plan_version_ref TEXT,
  entitlement_template_revision_ref TEXT,
  credit_program_revision_ref TEXT,
  credit_program_revision_version BIGINT,
  credit_program_revision_digest CHAR(64),
  PRIMARY KEY(fulfillment_program_revision_ref,output_line_id),
  UNIQUE(fulfillment_program_revision_ref,ordinal),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  FOREIGN KEY(entitlement_template_revision_ref,site_ref)
    REFERENCES platform.commerce_entitlement_template_revision(entitlement_template_revision_ref,site_ref),
  FOREIGN KEY(credit_program_revision_ref,site_ref,credit_program_revision_version,credit_program_revision_digest)
    REFERENCES platform.commerce_credit_program_revision(
      credit_program_revision_ref,site_ref,revision,revision_digest
    ),
  CHECK(
    (output_kind='subscription_term' AND plan_version_ref IS NOT NULL AND entitlement_template_revision_ref IS NULL
      AND credit_program_revision_ref IS NULL AND credit_program_revision_version IS NULL AND credit_program_revision_digest IS NULL)
    OR (output_kind='entitlement_grant' AND plan_version_ref IS NULL AND entitlement_template_revision_ref IS NOT NULL
      AND credit_program_revision_ref IS NULL AND credit_program_revision_version IS NULL AND credit_program_revision_digest IS NULL)
    OR (output_kind IN ('credit_grant','credit_program_enrollment') AND plan_version_ref IS NULL AND entitlement_template_revision_ref IS NULL
      AND credit_program_revision_ref IS NOT NULL AND credit_program_revision_version > 0
      AND credit_program_revision_digest ~ '^[a-f0-9]{64}$')
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
  safe_label TEXT NOT NULL CHECK(platform.commerce_safe_label_is_valid(safe_label)),
  plan_version_ref TEXT,
  fulfillment_program_revision_ref TEXT NOT NULL,
  legal_term_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK(cardinality(legal_term_refs) <= 16),
  revision_digest CHAR(64) NOT NULL CHECK(revision_digest ~ '^[a-f0-9]{64}$'),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,product_ref,revision),
  UNIQUE(site_ref,revision_digest),
  UNIQUE(product_version_ref,site_ref),
  UNIQUE(product_version_ref,site_ref,fulfillment_program_revision_ref),
  FOREIGN KEY(site_ref,product_ref) REFERENCES platform.commerce_catalog_product(site_ref,product_ref),
  FOREIGN KEY(plan_version_ref,site_ref) REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref)
);
CREATE INDEX commerce_product_version_catalog_page_idx
  ON platform.commerce_catalog_product_version(site_ref,product_version_ref,catalog_epoch);

CREATE TABLE platform.commerce_redemption_program_revision (
  redemption_program_revision_ref TEXT PRIMARY KEY CHECK(length(redemption_program_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  program_ref TEXT NOT NULL CHECK(length(program_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  product_version_ref TEXT NOT NULL,
  fulfillment_program_revision_ref TEXT NOT NULL,
  program_digest CHAR(64) NOT NULL CHECK(program_digest ~ '^[a-f0-9]{64}$'),
  max_redemptions_per_account INTEGER NOT NULL DEFAULT 1 CHECK(max_redemptions_per_account BETWEEN 1 AND 10000),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,program_ref,revision),
  UNIQUE(site_ref,program_digest),
  UNIQUE(redemption_program_revision_ref,site_ref),
  FOREIGN KEY(product_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_product_version(product_version_ref,site_ref),
  FOREIGN KEY(product_version_ref,site_ref,fulfillment_program_revision_ref)
    REFERENCES platform.commerce_catalog_product_version(product_version_ref,site_ref,fulfillment_program_revision_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref)
    REFERENCES platform.commerce_fulfillment_program_revision(fulfillment_program_revision_ref,site_ref)
);
CREATE INDEX commerce_redemption_program_catalog_page_idx
  ON platform.commerce_redemption_program_revision(site_ref,redemption_program_revision_ref,catalog_epoch);

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
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','payment','admin_grant','program_window')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_type,source_ref,plan_version_ref),
  UNIQUE(subscription_term_ref,site_ref),
  FOREIGN KEY(subscription_ref,site_ref)
    REFERENCES platform.commerce_subscription(subscription_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(plan_version_ref,site_ref)
    REFERENCES platform.commerce_catalog_plan_version(plan_version_ref,site_ref),
  CHECK(ends_at > starts_at)
);
CREATE INDEX commerce_subscription_term_account_end_idx
  ON platform.commerce_subscription_term(site_ref,billing_account_ref,ends_at DESC);

CREATE TABLE platform.commerce_subscription_term_revocation (
  term_revocation_ref UUID PRIMARY KEY,
  subscription_term_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption_reversal','admin_correction','program_revocation')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  case_ref TEXT NOT NULL CHECK(length(case_ref) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  revocation_digest CHAR(64) NOT NULL CHECK(revocation_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,subscription_term_ref),
  UNIQUE(site_ref,subscription_term_ref,source_type,source_ref),
  FOREIGN KEY(subscription_term_ref,site_ref)
    REFERENCES platform.commerce_subscription_term(subscription_term_ref,site_ref),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref)
);

CREATE TABLE platform.commerce_code_batch (
  batch_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  code_lookup_key_revision TEXT NOT NULL CHECK(code_lookup_key_revision ~ '^[A-Za-z0-9_-]{1,64}$'),
  batch_selector CHAR(10) NOT NULL CHECK(batch_selector ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  created_by_subject_ref TEXT NOT NULL CHECK(length(created_by_subject_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('draft','active','suspended','abandoned','revoked')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  inventory_count INTEGER NOT NULL CHECK(inventory_count >= 0),
  catalog_epoch BIGINT NOT NULL CHECK(catalog_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  UNIQUE(batch_ref,site_ref),
  UNIQUE(site_ref,batch_selector),
  UNIQUE(batch_ref,site_ref,code_lookup_key_revision),
  FOREIGN KEY(redemption_program_revision_ref,site_ref)
    REFERENCES platform.commerce_redemption_program_revision(redemption_program_revision_ref,site_ref),
  CHECK(ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK((state IN ('draft','abandoned') AND activated_at IS NULL)
    OR (state IN ('active','suspended','revoked') AND activated_at IS NOT NULL))
);
CREATE INDEX commerce_code_batch_catalog_page_idx
  ON platform.commerce_code_batch(site_ref,batch_ref,catalog_epoch);
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
  claimed_by_command_id TEXT,
  claimed_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,lookup_digest),
  UNIQUE(code_ref,site_ref),
  UNIQUE(code_ref,batch_ref,site_ref),
  FOREIGN KEY(batch_ref,site_ref,code_lookup_key_revision)
    REFERENCES platform.commerce_code_batch(batch_ref,site_ref,code_lookup_key_revision),
  FOREIGN KEY(claimed_by_command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref),
  CHECK(
    (state='available' AND claimed_by_command_id IS NULL AND claimed_at IS NULL AND voided_at IS NULL)
    OR (state='claimed' AND claimed_by_command_id IS NOT NULL AND claimed_at IS NOT NULL AND voided_at IS NULL)
    OR (state='void' AND claimed_by_command_id IS NULL AND claimed_at IS NULL AND voided_at IS NOT NULL)
  )
);
CREATE INDEX commerce_redeem_code_batch_state_idx
  ON platform.commerce_redeem_code(batch_ref,state);

CREATE TABLE platform.commerce_code_batch_approval (
  batch_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  maker_subject_ref TEXT NOT NULL CHECK(length(maker_subject_ref) BETWEEN 1 AND 256),
  checker_subject_ref TEXT NOT NULL CHECK(length(checker_subject_ref) BETWEEN 1 AND 256),
  approval_command_id TEXT NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL,
  approval_digest CHAR(64) NOT NULL CHECK(approval_digest ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY(batch_ref,site_ref) REFERENCES platform.commerce_code_batch(batch_ref,site_ref),
  FOREIGN KEY(approval_command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref),
  CHECK(maker_subject_ref<>checker_subject_ref)
);

CREATE TABLE platform.commerce_code_secret_export (
  batch_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  export_command_id TEXT NOT NULL,
  exported_to_subject_ref TEXT NOT NULL CHECK(length(exported_to_subject_ref) BETWEEN 1 AND 256),
  code_count INTEGER NOT NULL CHECK(code_count BETWEEN 1 AND 10000),
  export_digest CHAR(64) NOT NULL CHECK(export_digest ~ '^[a-f0-9]{64}$'),
  exported_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY(batch_ref,site_ref) REFERENCES platform.commerce_code_batch(batch_ref,site_ref),
  FOREIGN KEY(export_command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref)
);

CREATE TABLE platform.commerce_redemption (
  redemption_id UUID PRIMARY KEY,
  command_id TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  code_ref UUID NOT NULL,
  batch_ref UUID NOT NULL,
  redemption_program_revision_ref TEXT NOT NULL,
  product_version_ref TEXT NOT NULL,
  plan_version_ref TEXT,
  fulfillment_ref UUID,
  safe_code_fingerprint TEXT NOT NULL CHECK(safe_code_fingerprint ~ '^[A-Z0-9-]{4,32}$'),
  state TEXT NOT NULL CHECK(state IN ('executing','fulfilled','reversed','reconciliation_required')),
  redeemed_at TIMESTAMPTZ,
  state_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(redemption_id,site_ref),
  UNIQUE(site_ref,command_id),
  UNIQUE(site_ref,code_ref),
  UNIQUE(site_ref,fulfillment_ref),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref),
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
  command_id TEXT NOT NULL,
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
  consumed_by_command_id TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(preview_ref,site_ref),
  UNIQUE(site_ref,command_id),
  FOREIGN KEY(command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref),
  FOREIGN KEY(consumed_by_command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref),
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

CREATE TABLE platform.commerce_redemption_legal_acceptance (
  redemption_id UUID NOT NULL,
  site_ref TEXT NOT NULL,
  term_ref TEXT NOT NULL CHECK(length(term_ref) BETWEEN 1 AND 128),
  command_id TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  evidence_digest CHAR(64) NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(site_ref,redemption_id,term_ref),
  FOREIGN KEY(redemption_id,site_ref) REFERENCES platform.commerce_redemption(redemption_id,site_ref),
  FOREIGN KEY(command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref),
  FOREIGN KEY(workload_identity_id,site_ref)
    REFERENCES platform.authorization_product_binding(workload_identity_id,site_ref)
);

CREATE TABLE platform.commerce_entitlement_grant (
  entitlement_grant_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  entitlement_template_revision_ref TEXT NOT NULL,
  capability_key TEXT NOT NULL CHECK(capability_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  safe_label TEXT NOT NULL CHECK(platform.commerce_safe_label_is_valid(safe_label)),
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','payment','admin_grant','program_window')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_type,source_ref,entitlement_template_revision_ref),
  UNIQUE(entitlement_grant_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(entitlement_template_revision_ref,site_ref)
    REFERENCES platform.commerce_entitlement_template_revision(entitlement_template_revision_ref,site_ref),
  CHECK(expires_at IS NULL OR expires_at > effective_at)
);
CREATE INDEX commerce_entitlement_account_idx
  ON platform.commerce_entitlement_grant(site_ref,billing_account_ref,expires_at);

CREATE TABLE platform.commerce_entitlement_revocation (
  entitlement_revocation_ref UUID PRIMARY KEY,
  entitlement_grant_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption_reversal','admin_correction','program_revocation')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  case_ref TEXT NOT NULL CHECK(length(case_ref) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  revocation_digest CHAR(64) NOT NULL CHECK(revocation_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,entitlement_grant_ref),
  UNIQUE(site_ref,entitlement_grant_ref,source_type,source_ref),
  FOREIGN KEY(entitlement_grant_ref,site_ref)
    REFERENCES platform.commerce_entitlement_grant(entitlement_grant_ref,site_ref),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref)
);

CREATE TABLE platform.credit_account (
  credit_account_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('active','suspended','closed')),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,billing_account_ref,unit,liability_merchant_account_ref),
  UNIQUE(credit_account_ref,site_ref),
  UNIQUE(credit_account_ref,site_ref,unit),
  UNIQUE(credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref)
);

CREATE TABLE platform.credit_grant (
  credit_grant_id UUID PRIMARY KEY,
  credit_account_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  credit_program_revision_ref TEXT NOT NULL,
  credit_program_revision BIGINT NOT NULL CHECK(credit_program_revision > 0),
  credit_program_revision_digest CHAR(64) NOT NULL CHECK(credit_program_revision_digest ~ '^[a-f0-9]{64}$'),
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','payment','admin_grant','program_window')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  source_window_key TEXT NOT NULL DEFAULT '' CHECK(length(source_window_key) <= 256),
  issuance_journal_transaction_ref UUID NOT NULL,
  ux_bucket_class TEXT NOT NULL CHECK(ux_bucket_class IN ('daily','period','permanent')),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  original_amount NUMERIC(38,0) NOT NULL CHECK(original_amount > 0),
  burn_priority INTEGER NOT NULL,
  scope_policy JSONB NOT NULL CHECK(platform.valid_credit_scope_policy(scope_policy)),
  effective_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  acquired_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_type,source_ref,credit_program_revision_ref,source_window_key),
  UNIQUE(credit_grant_id,site_ref),
  UNIQUE(credit_grant_id,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref)
    REFERENCES platform.credit_account(
      credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref
    ),
  FOREIGN KEY(credit_program_revision_ref,site_ref,credit_program_revision,credit_program_revision_digest)
    REFERENCES platform.commerce_credit_program_revision(
      credit_program_revision_ref,site_ref,revision,revision_digest
    ),
  CHECK((ux_bucket_class='permanent' AND expires_at IS NULL) OR (ux_bucket_class<>'permanent' AND expires_at IS NOT NULL)),
  CHECK(expires_at IS NULL OR expires_at > effective_at)
);
CREATE INDEX credit_grant_spend_order_idx
  ON platform.credit_grant(credit_account_ref,expires_at ASC NULLS LAST,burn_priority ASC,issued_at ASC,credit_grant_id ASC);

CREATE TABLE platform.commerce_credit_program_enrollment (
  enrollment_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  subject_generation BIGINT NOT NULL CHECK(subject_generation > 0),
  credit_program_revision_ref TEXT NOT NULL,
  credit_program_revision BIGINT NOT NULL CHECK(credit_program_revision > 0),
  credit_program_revision_digest CHAR(64) NOT NULL CHECK(credit_program_revision_digest ~ '^[a-f0-9]{64}$'),
  subscription_term_ref UUID NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','payment','admin_grant')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  output_line_id TEXT NOT NULL CHECK(length(output_line_id) BETWEEN 1 AND 128),
  output_ordinal INTEGER NOT NULL CHECK(output_ordinal BETWEEN 1 AND 32),
  occurrence INTEGER NOT NULL CHECK(occurrence BETWEEN 1 AND 32),
  effective_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_type,source_ref,output_line_id,occurrence),
  UNIQUE(site_ref,source_type,source_ref,output_ordinal,occurrence),
  UNIQUE(enrollment_ref,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(subject_ref,site_ref) REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY(subscription_term_ref,site_ref)
    REFERENCES platform.commerce_subscription_term(subscription_term_ref,site_ref),
  FOREIGN KEY(credit_program_revision_ref,site_ref,credit_program_revision,credit_program_revision_digest)
    REFERENCES platform.commerce_credit_program_revision(
      credit_program_revision_ref,site_ref,revision,revision_digest
    ),
  CHECK(ends_at > effective_at)
);
CREATE INDEX commerce_credit_program_enrollment_due_idx
  ON platform.commerce_credit_program_enrollment(effective_at,ends_at,enrollment_ref);

CREATE TABLE platform.commerce_credit_program_enrollment_revocation (
  revocation_ref UUID PRIMARY KEY,
  enrollment_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption_reversal','admin_correction','program_revocation')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  case_ref TEXT NOT NULL CHECK(length(case_ref) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  revocation_digest CHAR(64) NOT NULL CHECK(revocation_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,enrollment_ref),
  FOREIGN KEY(enrollment_ref,site_ref)
    REFERENCES platform.commerce_credit_program_enrollment(enrollment_ref,site_ref),
  FOREIGN KEY(command_id,site_ref) REFERENCES platform.commerce_command(command_id,site_ref)
);

CREATE TABLE platform.commerce_credit_program_window_acquisition (
  acquisition_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  enrollment_ref UUID NOT NULL,
  window_key TEXT NOT NULL CHECK(length(window_key) BETWEEN 1 AND 256),
  window_starts_at TIMESTAMPTZ NOT NULL,
  window_ends_at TIMESTAMPTZ NOT NULL,
  credit_grant_ref UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,enrollment_ref,window_key),
  UNIQUE(site_ref,credit_grant_ref),
  FOREIGN KEY(enrollment_ref,site_ref)
    REFERENCES platform.commerce_credit_program_enrollment(enrollment_ref,site_ref),
  FOREIGN KEY(credit_grant_ref,site_ref) REFERENCES platform.credit_grant(credit_grant_id,site_ref),
  CHECK(window_ends_at > window_starts_at),
  CHECK(acquired_at >= window_starts_at AND acquired_at < window_ends_at)
);

CREATE TABLE platform.credit_hold (
  credit_hold_ref UUID PRIMARY KEY,
  credit_account_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  execution_root_ref TEXT NOT NULL CHECK(length(execution_root_ref) BETWEEN 1 AND 256),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  requested_amount NUMERIC(38,0) NOT NULL CHECK(requested_amount > 0),
  reserved_amount NUMERIC(38,0) NOT NULL CHECK(reserved_amount > 0),
  captured_amount NUMERIC(38,0) NOT NULL DEFAULT 0 CHECK(captured_amount >= 0),
  released_amount NUMERIC(38,0) NOT NULL DEFAULT 0 CHECK(released_amount >= 0),
  state TEXT NOT NULL CHECK(state IN ('open','closing','settled','released','expired','reconciliation_required')),
  resolution_kind TEXT CHECK(resolution_kind IS NULL OR resolution_kind IN ('reservation_expiry','known_outcome','reconciled')),
  resolution_ref TEXT CHECK(resolution_ref IS NULL OR length(resolution_ref) BETWEEN 1 AND 256),
  fence_epoch BIGINT NOT NULL DEFAULT 1 CHECK(fence_epoch > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,execution_root_ref,credit_account_ref),
  UNIQUE(credit_hold_ref,site_ref),
  UNIQUE(credit_hold_ref,site_ref,credit_account_ref,unit),
  UNIQUE(credit_hold_ref,site_ref,credit_account_ref,unit,execution_root_ref),
  FOREIGN KEY(credit_account_ref,site_ref,unit)
    REFERENCES platform.credit_account(credit_account_ref,site_ref,unit),
  CHECK(reserved_amount = requested_amount),
  CHECK(captured_amount + released_amount <= reserved_amount),
  CHECK((resolution_kind IS NULL) = (resolution_ref IS NULL)),
  CHECK(
    (state IN ('open','closing','reconciliation_required') AND resolution_kind IS NULL)
    OR (state='settled' AND resolution_kind IN ('known_outcome','reconciled'))
    OR (state='released' AND resolution_kind='known_outcome')
    OR (state='expired' AND resolution_kind='reservation_expiry')
  ),
  CHECK(
    (state='open' AND settled_at IS NULL AND released_at IS NULL)
    OR (state='closing' AND settled_at IS NULL AND released_at IS NULL)
    OR (state='settled' AND settled_at IS NOT NULL AND released_at IS NULL
      AND captured_amount+released_amount=reserved_amount)
    OR (state IN ('released','expired') AND settled_at IS NULL AND released_at IS NOT NULL
      AND captured_amount=0 AND released_amount=reserved_amount)
    OR (state='reconciliation_required' AND settled_at IS NULL AND released_at IS NULL)
  )
);

CREATE TABLE platform.credit_hold_allocation (
  credit_hold_ref UUID NOT NULL,
  credit_grant_id UUID NOT NULL,
  site_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  reserve_journal_transaction_ref UUID NOT NULL,
  allocated_amount NUMERIC(38,0) NOT NULL CHECK(allocated_amount > 0),
  allocation_ordinal INTEGER NOT NULL CHECK(allocation_ordinal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(credit_hold_ref,credit_grant_id),
  UNIQUE(credit_hold_ref,allocation_ordinal),
  UNIQUE(credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_grant_id,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_grant(credit_grant_id,site_ref,credit_account_ref,unit)
);

CREATE TABLE platform.credit_journal_transaction (
  journal_transaction_ref UUID PRIMARY KEY,
  credit_account_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('grant_issue','hold_reserve','hold_capture','hold_release','grant_expire','grant_revoke','correction','reversal')),
  expected_entry_count INTEGER NOT NULL CHECK(expected_entry_count BETWEEN 2 AND 512),
  entries_digest CHAR(64) NOT NULL CHECK(entries_digest ~ '^[a-f0-9]{64}$'),
  reversal_of_transaction_ref UUID,
  command_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,credit_account_ref,business_operation_key),
  UNIQUE(journal_transaction_ref,site_ref),
  UNIQUE(journal_transaction_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_account_ref,site_ref,unit)
    REFERENCES platform.credit_account(credit_account_ref,site_ref,unit),
  FOREIGN KEY(reversal_of_transaction_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_journal_transaction(journal_transaction_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref),
  CHECK((operation_kind='reversal') = (reversal_of_transaction_ref IS NOT NULL))
);

CREATE TABLE platform.credit_journal_entry (
  journal_transaction_ref UUID NOT NULL,
  entry_ordinal INTEGER NOT NULL CHECK(entry_ordinal >= 0),
  site_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  entry_side TEXT NOT NULL CHECK(entry_side IN ('debit','credit')),
  account_type TEXT NOT NULL CHECK(account_type IN (
    'grant_issuance_source','customer_available','customer_reserved','customer_consumed',
    'expired','revoked','adjustment','recovery_exposure'
  )),
  amount NUMERIC(38,0) NOT NULL CHECK(amount > 0),
  credit_grant_id UUID NOT NULL,
  credit_hold_ref UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(journal_transaction_ref,entry_ordinal),
  FOREIGN KEY(journal_transaction_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_journal_transaction(journal_transaction_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_grant_id,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_grant(credit_grant_id,site_ref,credit_account_ref,unit),
  FOREIGN KEY(credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold_allocation(
      credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit
    )
);
CREATE INDEX credit_journal_grant_idx
  ON platform.credit_journal_entry(credit_grant_id,journal_transaction_ref,entry_ordinal);

ALTER TABLE platform.credit_grant
  ADD CONSTRAINT credit_grant_issuance_journal_fk
  FOREIGN KEY(issuance_journal_transaction_ref,site_ref,credit_account_ref,unit)
  REFERENCES platform.credit_journal_transaction(
    journal_transaction_ref,site_ref,credit_account_ref,unit
  ) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE platform.credit_hold_allocation
  ADD CONSTRAINT credit_hold_allocation_reserve_journal_fk
  FOREIGN KEY(reserve_journal_transaction_ref,site_ref,credit_account_ref,unit)
  REFERENCES platform.credit_journal_transaction(
    journal_transaction_ref,site_ref,credit_account_ref,unit
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.credit_execution_budget_root (
  execution_budget_root_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_root_ref TEXT NOT NULL CHECK(length(execution_root_ref) BETWEEN 1 AND 256),
  billing_account_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  credit_hold_ref UUID NOT NULL,
  root_allocation_ref UUID NOT NULL,
  authorization_budget_ref TEXT NOT NULL CHECK(length(authorization_budget_ref) BETWEEN 1 AND 256),
  rating_policy_revision_ref TEXT NOT NULL CHECK(length(rating_policy_revision_ref) BETWEEN 1 AND 256),
  surface_ref TEXT NOT NULL CHECK(length(surface_ref) BETWEEN 1 AND 256),
  capability_key TEXT NOT NULL CHECK(length(capability_key) BETWEEN 1 AND 256),
  agent_ref TEXT CHECK(agent_ref IS NULL OR length(agent_ref) BETWEEN 1 AND 256),
  reserved_ceiling NUMERIC(38,0) NOT NULL CHECK(reserved_ceiling > 0),
  state TEXT NOT NULL CHECK(state IN ('open','closing','settled','reconciliation_required')),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,execution_root_ref,liability_merchant_account_ref),
  UNIQUE(site_ref,credit_hold_ref),
  UNIQUE(execution_budget_root_ref,site_ref),
  UNIQUE(execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref),
  UNIQUE(execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,credit_hold_ref),
  FOREIGN KEY(credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref)
    REFERENCES platform.credit_account(
      credit_account_ref,site_ref,billing_account_ref,unit,liability_merchant_account_ref
    ),
  FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit,execution_root_ref)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref,credit_account_ref,unit,execution_root_ref)
);

CREATE TABLE platform.credit_budget_allocation (
  budget_allocation_ref UUID PRIMARY KEY,
  execution_budget_root_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  parent_allocation_ref UUID,
  is_root BOOLEAN NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN (
    'root','model_gateway','capability_runtime','job','agent_team','target_runtime'
  )),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 128),
  surface_ref TEXT CHECK(surface_ref IS NULL OR length(surface_ref) BETWEEN 1 AND 256),
  operation_ref TEXT CHECK(operation_ref IS NULL OR length(operation_ref) BETWEEN 1 AND 256),
  agent_ref TEXT CHECK(agent_ref IS NULL OR length(agent_ref) BETWEEN 1 AND 256),
  current_revision BIGINT NOT NULL DEFAULT 0 CHECK(current_revision >= 0),
  current_allocation_epoch BIGINT NOT NULL DEFAULT 0 CHECK(current_allocation_epoch >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(budget_allocation_ref,site_ref),
  UNIQUE(budget_allocation_ref,site_ref,execution_budget_root_ref,credit_account_ref,unit),
  UNIQUE(budget_allocation_ref,site_ref,execution_budget_root_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref)
    REFERENCES platform.credit_execution_budget_root(
      execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref
    ),
  FOREIGN KEY(parent_allocation_ref,site_ref,execution_budget_root_ref,credit_account_ref,unit)
    REFERENCES platform.credit_budget_allocation(
      budget_allocation_ref,site_ref,execution_budget_root_ref,credit_account_ref,unit
    ),
  CHECK(
    (is_root AND parent_allocation_ref IS NULL AND audience='root')
    OR (NOT is_root AND parent_allocation_ref IS NOT NULL AND audience<>'root')
  )
);
CREATE UNIQUE INDEX credit_one_root_allocation_idx
  ON platform.credit_budget_allocation(site_ref,execution_budget_root_ref)
  WHERE is_root;

ALTER TABLE platform.credit_execution_budget_root
  ADD CONSTRAINT credit_execution_budget_root_allocation_fk
  FOREIGN KEY(root_allocation_ref,site_ref,execution_budget_root_ref,credit_account_ref,unit)
  REFERENCES platform.credit_budget_allocation(
    budget_allocation_ref,site_ref,execution_budget_root_ref,credit_account_ref,unit
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.credit_budget_allocation_revision (
  allocation_revision_ref UUID PRIMARY KEY,
  budget_allocation_ref UUID NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  billing_account_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision > 0),
  allocation_epoch BIGINT NOT NULL CHECK(allocation_epoch > 0),
  credit_ceiling NUMERIC(38,0) NOT NULL CHECK(credit_ceiling >= 0),
  unassigned_stock NUMERIC(38,0) NOT NULL CHECK(unassigned_stock >= 0),
  active_child_reserved_stock NUMERIC(38,0) NOT NULL CHECK(active_child_reserved_stock >= 0),
  committed_stock NUMERIC(38,0) NOT NULL CHECK(committed_stock >= 0),
  captured_cumulative NUMERIC(38,0) NOT NULL CHECK(captured_cumulative >= 0),
  returned_to_parent_cumulative NUMERIC(38,0) NOT NULL CHECK(returned_to_parent_cumulative >= 0),
  state TEXT NOT NULL CHECK(state IN ('active','returning','terminal','reconciliation_required')),
  terminal_receipt_digest CHAR(64) CHECK(terminal_receipt_digest IS NULL OR terminal_receipt_digest ~ '^[a-f0-9]{64}$'),
  parent_applied_revision BIGINT CHECK(parent_applied_revision IS NULL OR parent_applied_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(budget_allocation_ref,revision),
  UNIQUE(allocation_revision_ref,budget_allocation_ref),
  UNIQUE(budget_allocation_ref,revision,site_ref,execution_budget_root_ref),
  UNIQUE(budget_allocation_ref,revision,site_ref,execution_budget_root_ref,credit_account_ref,unit),
  FOREIGN KEY(budget_allocation_ref,site_ref,execution_budget_root_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref)
    REFERENCES platform.credit_budget_allocation(
      budget_allocation_ref,site_ref,execution_budget_root_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref
    ),
  CHECK(
    credit_ceiling = unassigned_stock + active_child_reserved_stock + committed_stock
      + captured_cumulative + returned_to_parent_cumulative
  ),
  CHECK(
    (state='terminal' AND terminal_receipt_digest IS NOT NULL)
    OR (state<>'terminal' AND terminal_receipt_digest IS NULL AND parent_applied_revision IS NULL)
  )
);
CREATE INDEX credit_budget_allocation_latest_idx
  ON platform.credit_budget_allocation_revision(budget_allocation_ref,revision DESC);

ALTER TABLE platform.credit_budget_allocation
  ADD CONSTRAINT credit_budget_allocation_current_revision_fk
  FOREIGN KEY(budget_allocation_ref,current_revision)
  REFERENCES platform.credit_budget_allocation_revision(budget_allocation_ref,revision)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.credit_allocation_reservation_receipt (
  allocation_reservation_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  parent_allocation_ref UUID NOT NULL,
  child_allocation_ref UUID NOT NULL,
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  reserved_ceiling NUMERIC(38,0) NOT NULL CHECK(reserved_ceiling > 0),
  parent_expected_revision BIGINT NOT NULL CHECK(parent_expected_revision > 0),
  parent_resulting_revision BIGINT NOT NULL CHECK(parent_resulting_revision=parent_expected_revision+1),
  child_initial_revision BIGINT NOT NULL DEFAULT 1 CHECK(child_initial_revision=1),
  receipt_digest CHAR(64) NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,parent_allocation_ref,business_operation_key),
  UNIQUE(site_ref,child_allocation_ref),
  FOREIGN KEY(parent_allocation_ref,parent_expected_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    ),
  FOREIGN KEY(parent_allocation_ref,parent_resulting_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    ),
  FOREIGN KEY(child_allocation_ref,child_initial_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    )
);

CREATE TABLE platform.credit_allocation_return_receipt (
  allocation_return_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  parent_allocation_ref UUID NOT NULL,
  child_allocation_ref UUID NOT NULL,
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  returned_amount NUMERIC(38,0) NOT NULL CHECK(returned_amount >= 0),
  child_terminal_revision BIGINT NOT NULL CHECK(child_terminal_revision > 1),
  parent_resulting_revision BIGINT NOT NULL CHECK(parent_resulting_revision > 1),
  fence_epoch BIGINT NOT NULL CHECK(fence_epoch > 0),
  reason TEXT NOT NULL CHECK(reason IN ('completed','canceled_before_effect','fenced_recovery','root_closing')),
  receipt_digest CHAR(64) NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,child_allocation_ref),
  UNIQUE(site_ref,parent_allocation_ref,business_operation_key),
  FOREIGN KEY(child_allocation_ref,child_terminal_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    ),
  FOREIGN KEY(parent_allocation_ref,parent_resulting_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    )
);

CREATE TABLE platform.credit_authorization_segment (
  authorization_segment_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  budget_allocation_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  billing_account_ref TEXT NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  liability_merchant_account_ref TEXT NOT NULL CHECK(length(liability_merchant_account_ref) BETWEEN 1 AND 256),
  execution_manifest_ref TEXT NOT NULL CHECK(length(execution_manifest_ref) BETWEEN 1 AND 256),
  rating_policy_revision_ref TEXT NOT NULL CHECK(length(rating_policy_revision_ref) BETWEEN 1 AND 256),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  maximum_amount NUMERIC(38,0) NOT NULL CHECK(maximum_amount > 0),
  allocation_epoch BIGINT NOT NULL CHECK(allocation_epoch > 0),
  prepared_against_allocation_revision BIGINT NOT NULL CHECK(prepared_against_allocation_revision > 0),
  committed_from_allocation_revision BIGINT,
  committed_to_allocation_revision BIGINT,
  state TEXT NOT NULL CHECK(state IN (
    'reserved','committed','rating_pending','settled','released','expired','reconciliation_required'
  )),
  resolution_kind TEXT CHECK(resolution_kind IS NULL OR resolution_kind IN (
    'not_dispatched','reservation_expiry','outcome_unknown','rated','reconciled'
  )),
  resolution_ref TEXT CHECK(resolution_ref IS NULL OR length(resolution_ref) BETWEEN 1 AND 256),
  fence_epoch BIGINT NOT NULL DEFAULT 1 CHECK(fence_epoch > 0),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK(aggregate_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(authorization_segment_ref,site_ref),
  UNIQUE(site_ref,budget_allocation_ref,business_operation_key),
  FOREIGN KEY(budget_allocation_ref,site_ref,execution_budget_root_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref)
    REFERENCES platform.credit_budget_allocation(
      budget_allocation_ref,site_ref,execution_budget_root_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref
    ),
  FOREIGN KEY(execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,credit_hold_ref)
    REFERENCES platform.credit_execution_budget_root(
      execution_budget_root_ref,site_ref,billing_account_ref,credit_account_ref,unit,liability_merchant_account_ref,credit_hold_ref
    ),
  FOREIGN KEY(budget_allocation_ref,prepared_against_allocation_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    ),
  FOREIGN KEY(budget_allocation_ref,committed_from_allocation_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
    ),
  FOREIGN KEY(budget_allocation_ref,committed_to_allocation_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref
  ),
  CHECK((resolution_kind IS NULL) = (resolution_ref IS NULL)),
  CHECK(
    (state IN ('reserved','committed','rating_pending') AND resolution_kind IS NULL)
    OR (state='reconciliation_required' AND resolution_kind='outcome_unknown')
    OR (state='settled' AND resolution_kind IN ('rated','reconciled'))
    OR (state='released' AND resolution_kind='not_dispatched')
    OR (state='expired' AND resolution_kind='reservation_expiry')
  ),
  CHECK(
    (state='reserved' AND committed_from_allocation_revision IS NULL AND committed_to_allocation_revision IS NULL
      AND committed_at IS NULL AND settled_at IS NULL AND released_at IS NULL)
    OR (state IN ('committed','rating_pending','reconciliation_required')
      AND committed_from_allocation_revision IS NOT NULL AND committed_to_allocation_revision IS NOT NULL
      AND committed_at IS NOT NULL AND settled_at IS NULL AND released_at IS NULL)
    OR (state='settled' AND committed_from_allocation_revision IS NOT NULL
      AND committed_to_allocation_revision IS NOT NULL
      AND committed_at IS NOT NULL AND settled_at IS NOT NULL AND released_at IS NULL)
    OR (state IN ('released','expired') AND committed_at IS NULL AND settled_at IS NULL AND released_at IS NOT NULL)
  )
);
CREATE INDEX credit_authorization_segment_allocation_state_idx
  ON platform.credit_authorization_segment(site_ref,budget_allocation_ref,state,expires_at);

CREATE TABLE platform.credit_budget_operation_receipt (
  operation_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN (
    'reserve_root','finalize_segment','release_segment','reconcile_segment'
  )),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  execution_budget_root_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('accepted','reconciliation_required')),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  result_digest CHAR(64) NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  outbox_event_ref UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,operation_kind,business_operation_key),
  UNIQUE(operation_receipt_ref,site_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref)
);

CREATE TABLE platform.commerce_fulfillment_transaction (
  fulfillment_id UUID PRIMARY KEY,
  command_id TEXT,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  billing_account_ref TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('redemption','payment','admin_grant','program_window')),
  source_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  cycle_key TEXT NOT NULL,
  idempotency_key CHAR(64) NOT NULL UNIQUE CHECK(idempotency_key ~ '^[a-f0-9]{64}$'),
  source_version BIGINT NOT NULL CHECK(source_version > 0),
  source_digest CHAR(64) NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  acquired_at TIMESTAMPTZ NOT NULL,
  product_version_ref TEXT NOT NULL,
  plan_version_ref TEXT,
  offering_version_ref TEXT NOT NULL,
  fulfillment_program_revision_ref TEXT NOT NULL,
  fulfillment_program_revision BIGINT NOT NULL CHECK(fulfillment_program_revision > 0),
  fulfillment_program_digest CHAR(64) NOT NULL CHECK(fulfillment_program_digest ~ '^[a-f0-9]{64}$'),
  pricing_snapshot_ref TEXT CHECK(pricing_snapshot_ref IS NULL OR length(pricing_snapshot_ref) BETWEEN 1 AND 256),
  output_set_digest CHAR(64) NOT NULL CHECK(output_set_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state='committed'),
  transaction_version BIGINT NOT NULL CHECK(transaction_version=1),
  transaction_digest CHAR(64) NOT NULL CHECK(transaction_digest ~ '^[a-f0-9]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_type,source_id,purpose,cycle_key),
  UNIQUE(fulfillment_id,site_ref),
  FOREIGN KEY(command_id,site_ref)
    REFERENCES platform.commerce_command(command_id,site_ref),
  FOREIGN KEY(billing_account_ref,site_ref)
    REFERENCES platform.commerce_billing_account(billing_account_ref,site_ref),
  FOREIGN KEY(fulfillment_program_revision_ref,site_ref,fulfillment_program_revision,fulfillment_program_digest)
    REFERENCES platform.commerce_fulfillment_program_revision(
      fulfillment_program_revision_ref,site_ref,revision,output_plan_digest
    ),
  CHECK(committed_at >= acquired_at),
  CHECK(source_type<>'payment' OR pricing_snapshot_ref IS NOT NULL)
);
CREATE INDEX commerce_fulfillment_account_idx
  ON platform.commerce_fulfillment_transaction(site_ref,billing_account_ref);

ALTER TABLE platform.commerce_redemption
  ADD CONSTRAINT commerce_redemption_fulfillment_fk
  FOREIGN KEY(fulfillment_ref,site_ref)
  REFERENCES platform.commerce_fulfillment_transaction(fulfillment_id,site_ref);
CREATE TABLE platform.commerce_fulfillment_output_plan (
  fulfillment_id UUID NOT NULL REFERENCES platform.commerce_fulfillment_transaction(fulfillment_id),
  output_line_id TEXT NOT NULL CHECK (length(output_line_id) BETWEEN 1 AND 128),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 32),
  cardinality INTEGER NOT NULL CHECK (cardinality BETWEEN 0 AND 32),
  template_revision TEXT NOT NULL CHECK (length(template_revision) BETWEEN 1 AND 256),
  output_kind TEXT NOT NULL CHECK (output_kind IN ('subscription','subscription_term','entitlement_grant','credit_grant','credit_program_enrollment')),
  disposition TEXT NOT NULL CHECK (disposition IN ('required','optional','forbidden')),
  PRIMARY KEY(fulfillment_id,output_line_id),
  UNIQUE(fulfillment_id,ordinal),
  UNIQUE(fulfillment_id,output_line_id,ordinal,cardinality,template_revision,output_kind),
  CHECK (
    (disposition='forbidden' AND cardinality=0)
    OR (disposition IN ('required','optional') AND cardinality > 0)
  )
);

CREATE TABLE platform.commerce_fulfillment_actual_output (
  fulfillment_id UUID NOT NULL,
  output_line_id TEXT NOT NULL,
  output_ordinal INTEGER NOT NULL CHECK(output_ordinal BETWEEN 1 AND 32),
  occurrence INTEGER NOT NULL,
  cardinality INTEGER NOT NULL,
  template_revision TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  output_ref TEXT NOT NULL CHECK (length(output_ref) BETWEEN 1 AND 256),
  output_version BIGINT NOT NULL CHECK(output_version=1),
  output_digest CHAR(64) NOT NULL CHECK(output_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(fulfillment_id,output_line_id,occurrence),
  UNIQUE(fulfillment_id,output_ref),
  UNIQUE(fulfillment_id,output_kind,output_ref,output_version,output_digest),
  CHECK (occurrence BETWEEN 1 AND cardinality),
  FOREIGN KEY(fulfillment_id,output_line_id,output_ordinal,cardinality,template_revision,output_kind)
    REFERENCES platform.commerce_fulfillment_output_plan(
      fulfillment_id,output_line_id,ordinal,cardinality,template_revision,output_kind
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
  total_cardinality INTEGER;
  min_ordinal INTEGER;
  max_ordinal INTEGER;
BEGIN
  SELECT count(*),COALESCE(sum(cardinality),0),min(ordinal),max(ordinal)
    INTO line_count,total_cardinality,min_ordinal,max_ordinal
  FROM platform.commerce_fulfillment_output_plan
  WHERE fulfillment_id=NEW.fulfillment_id;
  IF line_count < 1 OR line_count > 32 OR total_cardinality < 1 OR total_cardinality > 32
     OR min_ordinal <> 1 OR max_ordinal <> line_count THEN
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

CREATE FUNCTION platform.assert_commerce_fulfillment_committed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.state<>'committed' OR NEW.transaction_version<>1 OR NOT EXISTS (
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

CREATE FUNCTION platform.assert_credit_journal_transaction_balanced() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  target_ref UUID := NEW.journal_transaction_ref;
  expected_count INTEGER;
  actual_count INTEGER;
  min_ordinal INTEGER;
  max_ordinal INTEGER;
  debit_total NUMERIC(38,0);
  credit_total NUMERIC(38,0);
  expected_digest CHAR(64);
  actual_digest TEXT;
  target_operation_kind TEXT;
  reversal_ref UUID;
  invalid_shape BOOLEAN := FALSE;
BEGIN
  SELECT expected_entry_count,entries_digest,operation_kind,reversal_of_transaction_ref
    INTO expected_count,expected_digest,target_operation_kind,reversal_ref
  FROM platform.credit_journal_transaction
  WHERE journal_transaction_ref=target_ref;
  SELECT count(*)::INTEGER,
         min(entry_ordinal),
         max(entry_ordinal),
         COALESCE(sum(amount) FILTER (WHERE entry_side='debit'),0),
         COALESCE(sum(amount) FILTER (WHERE entry_side='credit'),0),
         encode(sha256(convert_to(string_agg(
           octet_length(entry_ordinal::TEXT)::TEXT || ':' || entry_ordinal::TEXT ||
           octet_length(site_ref)::TEXT || ':' || site_ref ||
           octet_length(credit_account_ref::TEXT)::TEXT || ':' || credit_account_ref::TEXT ||
           octet_length(unit)::TEXT || ':' || unit ||
           octet_length(entry_side)::TEXT || ':' || entry_side ||
           octet_length(account_type)::TEXT || ':' || account_type ||
           octet_length(amount::TEXT)::TEXT || ':' || amount::TEXT ||
           octet_length(credit_grant_id::TEXT)::TEXT || ':' || credit_grant_id::TEXT ||
           octet_length(COALESCE(credit_hold_ref::TEXT,''))::TEXT || ':' || COALESCE(credit_hold_ref::TEXT,''),
           '' ORDER BY entry_ordinal
         ),'UTF8')),'hex')
    INTO actual_count,min_ordinal,max_ordinal,debit_total,credit_total,actual_digest
  FROM platform.credit_journal_entry
  WHERE journal_transaction_ref=target_ref;
  IF expected_count IS NULL
     OR actual_count<>expected_count
     OR min_ordinal<>0
     OR max_ordinal<>expected_count-1
     OR debit_total<>credit_total
     OR actual_digest<>expected_digest THEN
    RAISE EXCEPTION 'CREDIT_JOURNAL_UNBALANCED' USING ERRCODE='23514';
  END IF;
  SELECT CASE target_operation_kind
    WHEN 'grant_issue' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        credit_hold_ref IS NOT NULL
        OR (entry_side='debit' AND account_type<>'grant_issuance_source')
        OR (entry_side='credit' AND account_type<>'customer_available')
      )
    )
    WHEN 'hold_reserve' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        credit_hold_ref IS NULL
        OR (entry_side='debit' AND account_type<>'customer_available')
        OR (entry_side='credit' AND account_type<>'customer_reserved')
      )
    )
    WHEN 'hold_capture' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        credit_hold_ref IS NULL
        OR (entry_side='debit' AND account_type<>'customer_reserved')
        OR (entry_side='credit' AND account_type<>'customer_consumed')
      )
    )
    WHEN 'hold_release' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        credit_hold_ref IS NULL
        OR (entry_side='debit' AND account_type<>'customer_reserved')
        OR (entry_side='credit' AND account_type NOT IN ('customer_available','expired','revoked'))
      )
    )
    WHEN 'grant_expire' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        credit_hold_ref IS NOT NULL
        OR (entry_side='debit' AND account_type<>'customer_available')
        OR (entry_side='credit' AND account_type<>'expired')
      )
    )
    WHEN 'grant_revoke' THEN EXISTS (
      SELECT 1 FROM platform.credit_journal_entry
      WHERE journal_transaction_ref=target_ref AND (
        (entry_side='debit' AND account_type NOT IN ('customer_available','customer_reserved'))
        OR (entry_side='credit' AND account_type NOT IN ('revoked','recovery_exposure'))
      )
    )
    WHEN 'correction' THEN
      NOT EXISTS (
        SELECT 1 FROM platform.credit_journal_entry
        WHERE journal_transaction_ref=target_ref AND account_type='adjustment'
      ) OR EXISTS (
        SELECT 1 FROM platform.credit_journal_entry
        WHERE journal_transaction_ref=target_ref AND account_type='grant_issuance_source'
      )
    WHEN 'reversal' THEN
      EXISTS (
        SELECT 1
        FROM platform.credit_journal_entry original
        LEFT JOIN platform.credit_journal_entry reversed
          ON reversed.journal_transaction_ref=target_ref
         AND reversed.entry_ordinal=original.entry_ordinal
         AND reversed.site_ref=original.site_ref
         AND reversed.credit_account_ref=original.credit_account_ref
         AND reversed.unit=original.unit
         AND reversed.entry_side=CASE original.entry_side WHEN 'debit' THEN 'credit' ELSE 'debit' END
         AND reversed.account_type=original.account_type
         AND reversed.amount=original.amount
         AND reversed.credit_grant_id=original.credit_grant_id
         AND reversed.credit_hold_ref IS NOT DISTINCT FROM original.credit_hold_ref
        WHERE original.journal_transaction_ref=reversal_ref
          AND reversed.journal_transaction_ref IS NULL
      ) OR expected_count<>(
        SELECT expected_entry_count FROM platform.credit_journal_transaction
        WHERE journal_transaction_ref=reversal_ref
      )
    ELSE TRUE
  END INTO invalid_shape;
  IF invalid_shape THEN
    RAISE EXCEPTION 'CREDIT_JOURNAL_OPERATION_SHAPE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.assert_credit_hold_fully_allocated() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  target_ref UUID := NEW.credit_hold_ref;
  reserved_total NUMERIC(38,0);
  allocated_total NUMERIC(38,0);
BEGIN
  SELECT reserved_amount INTO reserved_total
  FROM platform.credit_hold
  WHERE credit_hold_ref=target_ref;
  SELECT COALESCE(sum(allocated_amount),0) INTO allocated_total
  FROM platform.credit_hold_allocation
  WHERE credit_hold_ref=target_ref;
  IF reserved_total IS NULL OR allocated_total<>reserved_total THEN
    RAISE EXCEPTION 'CREDIT_HOLD_ALLOCATION_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.assert_credit_journal_cross_fact_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  payload JSONB := to_jsonb(NEW);
  target_grant_id UUID := NULLIF(payload->>'credit_grant_id','')::UUID;
  target_hold_ref UUID := NULLIF(payload->>'credit_hold_ref','')::UUID;
  grant_fact platform.credit_grant%ROWTYPE;
  program_fact platform.commerce_credit_program_revision%ROWTYPE;
  hold_fact platform.credit_hold%ROWTYPE;
  allocation_fact platform.credit_hold_allocation%ROWTYPE;
  issue_debit NUMERIC(38,0);
  issue_credit NUMERIC(38,0);
  issue_transaction_count INTEGER;
  reserve_debit NUMERIC(38,0);
  reserve_credit NUMERIC(38,0);
  reserve_transaction_count INTEGER;
  captured_total NUMERIC(38,0);
  released_total NUMERIC(38,0);
  hold_captured_total NUMERIC(38,0);
  hold_released_total NUMERIC(38,0);
  linked_operation_kind TEXT;
  available_balance NUMERIC(38,0);
  reserved_balance NUMERIC(38,0);
  consumed_balance NUMERIC(38,0);
  expired_balance NUMERIC(38,0);
  revoked_balance NUMERIC(38,0);
BEGIN
  IF target_grant_id IS NOT NULL THEN
    SELECT * INTO grant_fact FROM platform.credit_grant
    WHERE credit_grant_id=target_grant_id;
    SELECT * INTO program_fact FROM platform.commerce_credit_program_revision
    WHERE credit_program_revision_ref=grant_fact.credit_program_revision_ref;
    SELECT operation_kind INTO linked_operation_kind
    FROM platform.credit_journal_transaction
    WHERE journal_transaction_ref=grant_fact.issuance_journal_transaction_ref;
    SELECT
      COALESCE(sum(entry.amount) FILTER (
        WHERE entry.entry_side='debit' AND entry.account_type='grant_issuance_source'
      ),0),
      COALESCE(sum(entry.amount) FILTER (
        WHERE entry.entry_side='credit' AND entry.account_type='customer_available'
      ),0),
      count(DISTINCT transaction.journal_transaction_ref)::INTEGER
      INTO issue_debit,issue_credit,issue_transaction_count
    FROM platform.credit_journal_entry entry
    JOIN platform.credit_journal_transaction transaction
      ON transaction.journal_transaction_ref=entry.journal_transaction_ref
    WHERE entry.credit_grant_id=target_grant_id AND transaction.operation_kind='grant_issue';
    SELECT
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_available'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_reserved'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_consumed'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='expired'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='revoked'),0)
      INTO available_balance,reserved_balance,consumed_balance,expired_balance,revoked_balance
    FROM platform.credit_journal_entry entry
    WHERE entry.credit_grant_id=target_grant_id;
    IF grant_fact.credit_grant_id IS NULL
       OR program_fact.credit_program_revision_ref IS NULL
       OR grant_fact.ux_bucket_class<>program_fact.ux_bucket_class
       OR grant_fact.unit<>program_fact.unit
       OR grant_fact.liability_merchant_account_ref<>program_fact.liability_merchant_account_ref
       OR grant_fact.original_amount<>program_fact.amount
       OR grant_fact.burn_priority<>program_fact.burn_priority
       OR grant_fact.scope_policy IS DISTINCT FROM program_fact.scope_policy
       OR (program_fact.expires_after_seconds IS NULL)<>(grant_fact.expires_at IS NULL)
       OR (program_fact.expires_after_seconds IS NOT NULL AND grant_fact.expires_at<>
         grant_fact.effective_at+(program_fact.expires_after_seconds*INTERVAL '1 second'))
       OR linked_operation_kind<>'grant_issue'
       OR issue_debit<>grant_fact.original_amount
       OR issue_credit<>grant_fact.original_amount
       OR issue_transaction_count<>1
       OR available_balance<0 OR reserved_balance<0 OR consumed_balance<0
       OR expired_balance<0 OR revoked_balance<0
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         WHERE entry.credit_grant_id=target_grant_id
         GROUP BY entry.journal_transaction_ref
         HAVING COALESCE(sum(entry.amount) FILTER (WHERE entry.entry_side='debit'),0)
              <>COALESCE(sum(entry.amount) FILTER (WHERE entry.entry_side='credit'),0)
       )
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         JOIN platform.credit_journal_transaction transaction
           ON transaction.journal_transaction_ref=entry.journal_transaction_ref
         WHERE entry.credit_grant_id=target_grant_id
           AND transaction.operation_kind='grant_issue'
           AND transaction.journal_transaction_ref<>grant_fact.issuance_journal_transaction_ref
       ) THEN
      RAISE EXCEPTION 'CREDIT_GRANT_ISSUANCE_JOURNAL_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;

  IF target_hold_ref IS NOT NULL THEN
    SELECT * INTO hold_fact FROM platform.credit_hold WHERE credit_hold_ref=target_hold_ref;
    FOR allocation_fact IN
      SELECT * FROM platform.credit_hold_allocation WHERE credit_hold_ref=target_hold_ref
    LOOP
      SELECT operation_kind INTO linked_operation_kind
      FROM platform.credit_journal_transaction
      WHERE journal_transaction_ref=allocation_fact.reserve_journal_transaction_ref;
      SELECT
        COALESCE(sum(entry.amount) FILTER (
          WHERE entry.entry_side='debit' AND entry.account_type='customer_available'
        ),0),
        COALESCE(sum(entry.amount) FILTER (
          WHERE entry.entry_side='credit' AND entry.account_type='customer_reserved'
        ),0),
        count(DISTINCT transaction.journal_transaction_ref)::INTEGER
        INTO reserve_debit,reserve_credit,reserve_transaction_count
      FROM platform.credit_journal_entry entry
      JOIN platform.credit_journal_transaction transaction
        ON transaction.journal_transaction_ref=entry.journal_transaction_ref
      WHERE entry.credit_hold_ref=target_hold_ref
        AND entry.credit_grant_id=allocation_fact.credit_grant_id
        AND transaction.operation_kind='hold_reserve';
      SELECT
        COALESCE(sum(entry.amount) FILTER (
          WHERE transaction.operation_kind='hold_capture'
            AND entry.entry_side='credit' AND entry.account_type='customer_consumed'
        ),0),
        COALESCE(sum(entry.amount) FILTER (
          WHERE transaction.operation_kind='hold_release'
            AND entry.entry_side='credit' AND entry.account_type IN ('customer_available','expired','revoked')
        ),0)
        INTO captured_total,released_total
      FROM platform.credit_journal_entry entry
      JOIN platform.credit_journal_transaction transaction
        ON transaction.journal_transaction_ref=entry.journal_transaction_ref
      WHERE entry.credit_hold_ref=target_hold_ref
        AND entry.credit_grant_id=allocation_fact.credit_grant_id;
      IF linked_operation_kind<>'hold_reserve'
         OR reserve_debit<>allocation_fact.allocated_amount
         OR reserve_credit<>allocation_fact.allocated_amount
         OR reserve_transaction_count<>1
         OR captured_total+released_total>allocation_fact.allocated_amount
         OR EXISTS (
           SELECT 1
           FROM platform.credit_journal_entry entry
           JOIN platform.credit_journal_transaction transaction
             ON transaction.journal_transaction_ref=entry.journal_transaction_ref
           WHERE entry.credit_hold_ref=target_hold_ref
             AND entry.credit_grant_id=allocation_fact.credit_grant_id
             AND transaction.operation_kind='hold_reserve'
             AND transaction.journal_transaction_ref<>allocation_fact.reserve_journal_transaction_ref
         ) THEN
        RAISE EXCEPTION 'CREDIT_HOLD_ALLOCATION_JOURNAL_MISMATCH' USING ERRCODE='23514';
      END IF;
    END LOOP;
    SELECT
      COALESCE(sum(entry.amount) FILTER (
        WHERE transaction.operation_kind='hold_capture'
          AND entry.entry_side='credit' AND entry.account_type='customer_consumed'
      ),0),
      COALESCE(sum(entry.amount) FILTER (
        WHERE transaction.operation_kind='hold_release'
          AND entry.entry_side='credit' AND entry.account_type IN ('customer_available','expired','revoked')
      ),0)
      INTO hold_captured_total,hold_released_total
    FROM platform.credit_journal_entry entry
    JOIN platform.credit_journal_transaction transaction
      ON transaction.journal_transaction_ref=entry.journal_transaction_ref
    WHERE entry.credit_hold_ref=target_hold_ref;
    IF hold_fact.credit_hold_ref IS NULL
       OR hold_fact.captured_amount<>hold_captured_total
       OR hold_fact.released_amount<>hold_released_total
       OR (hold_fact.state IN ('settled','released','expired')
         AND hold_captured_total+hold_released_total<>hold_fact.reserved_amount)
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         JOIN platform.credit_journal_transaction transaction
           ON transaction.journal_transaction_ref=entry.journal_transaction_ref
         JOIN platform.credit_grant hold_grant
           ON hold_grant.credit_grant_id=entry.credit_grant_id
         WHERE entry.credit_hold_ref=target_hold_ref
           AND transaction.operation_kind='hold_release'
           AND entry.entry_side='credit'
           AND entry.account_type<>CASE
             WHEN EXISTS (
               SELECT 1
               FROM platform.credit_journal_entry revoke_entry
               JOIN platform.credit_journal_transaction revoke_transaction
                 ON revoke_transaction.journal_transaction_ref=revoke_entry.journal_transaction_ref
               WHERE revoke_entry.credit_grant_id=entry.credit_grant_id
                 AND revoke_transaction.operation_kind='grant_revoke'
                 AND revoke_transaction.occurred_at<=transaction.occurred_at
             ) THEN 'revoked'
             WHEN hold_grant.expires_at IS NOT NULL AND hold_grant.expires_at<=transaction.occurred_at THEN 'expired'
             ELSE 'customer_available'
           END
       ) THEN
      RAISE EXCEPTION 'CREDIT_HOLD_JOURNAL_TOTAL_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.advance_credit_budget_allocation_revision() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  head_revision BIGINT;
  head_epoch BIGINT;
  target_is_root BOOLEAN;
  root_reserved_ceiling NUMERIC(38,0);
  prior platform.credit_budget_allocation_revision%ROWTYPE;
BEGIN
  SELECT allocation.current_revision,allocation.current_allocation_epoch,allocation.is_root,root.reserved_ceiling
    INTO head_revision,head_epoch,target_is_root,root_reserved_ceiling
  FROM platform.credit_budget_allocation allocation
  JOIN platform.credit_execution_budget_root root
    ON root.execution_budget_root_ref=allocation.execution_budget_root_ref
  WHERE allocation.budget_allocation_ref=NEW.budget_allocation_ref
  FOR UPDATE OF allocation;
  IF head_revision IS NULL OR NEW.revision<>head_revision+1 THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  IF target_is_root AND NEW.credit_ceiling<>root_reserved_ceiling THEN
    RAISE EXCEPTION 'CREDIT_ROOT_ALLOCATION_CEILING_DRIFT' USING ERRCODE='23514';
  END IF;
  IF head_revision=0 THEN
    IF NEW.revision<>1 OR NEW.allocation_epoch<>1 OR NEW.state<>'active'
       OR NEW.captured_cumulative<>0 OR NEW.returned_to_parent_cumulative<>0 THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_INITIAL_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO prior
    FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.budget_allocation_ref AND revision=head_revision;
    IF prior.state='terminal'
       OR NEW.allocation_epoch NOT IN (head_epoch,head_epoch+1)
       OR NEW.credit_ceiling<>prior.credit_ceiling
       OR NEW.captured_cumulative<prior.captured_cumulative
       OR NEW.returned_to_parent_cumulative<prior.returned_to_parent_cumulative THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  UPDATE platform.credit_budget_allocation
  SET current_revision=NEW.revision,current_allocation_epoch=NEW.allocation_epoch
  WHERE budget_allocation_ref=NEW.budget_allocation_ref
    AND current_revision=head_revision AND current_allocation_epoch=head_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.assert_credit_allocation_origin_and_root() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  payload JSONB := to_jsonb(NEW);
  target_allocation_ref UUID;
  target_allocation platform.credit_budget_allocation%ROWTYPE;
  root_fact platform.credit_execution_budget_root%ROWTYPE;
  initial_fact platform.credit_budget_allocation_revision%ROWTYPE;
  reservation_count INTEGER;
  reservation_ceiling NUMERIC(38,0);
  has_cycle BOOLEAN;
BEGIN
  target_allocation_ref := CASE TG_TABLE_NAME
    WHEN 'credit_allocation_reservation_receipt'
      THEN (payload->>'child_allocation_ref')::UUID
    ELSE (payload->>'budget_allocation_ref')::UUID
  END;
  SELECT * INTO target_allocation FROM platform.credit_budget_allocation
  WHERE budget_allocation_ref=target_allocation_ref;
  SELECT * INTO root_fact FROM platform.credit_execution_budget_root
  WHERE execution_budget_root_ref=target_allocation.execution_budget_root_ref;
  SELECT * INTO initial_fact FROM platform.credit_budget_allocation_revision
  WHERE budget_allocation_ref=target_allocation_ref AND revision=1;
  SELECT count(*)::INTEGER,max(reserved_ceiling)
    INTO reservation_count,reservation_ceiling
  FROM platform.credit_allocation_reservation_receipt
  WHERE child_allocation_ref=target_allocation_ref;
  WITH RECURSIVE lineage(budget_allocation_ref,parent_allocation_ref,path,cycle) AS (
    SELECT allocation.budget_allocation_ref,allocation.parent_allocation_ref,
           ARRAY[allocation.budget_allocation_ref],FALSE
    FROM platform.credit_budget_allocation allocation
    WHERE allocation.budget_allocation_ref=target_allocation_ref
    UNION ALL
    SELECT parent.budget_allocation_ref,parent.parent_allocation_ref,
           lineage.path||parent.budget_allocation_ref,
           parent.budget_allocation_ref=ANY(lineage.path)
    FROM platform.credit_budget_allocation parent
    JOIN lineage ON parent.budget_allocation_ref=lineage.parent_allocation_ref
    WHERE NOT lineage.cycle
  ) SELECT COALESCE(bool_or(cycle),FALSE) INTO has_cycle FROM lineage;
  IF target_allocation.budget_allocation_ref IS NULL
     OR root_fact.execution_budget_root_ref IS NULL
     OR initial_fact.budget_allocation_ref IS NULL
     OR has_cycle THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  IF target_allocation.is_root THEN
    IF target_allocation.parent_allocation_ref IS NOT NULL
       OR root_fact.root_allocation_ref<>target_allocation_ref
       OR initial_fact.credit_ceiling<>root_fact.reserved_ceiling
       OR reservation_count<>0 THEN
      RAISE EXCEPTION 'CREDIT_ROOT_ALLOCATION_ORIGIN_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF target_allocation.parent_allocation_ref IS NULL
     OR reservation_count<>1
     OR initial_fact.credit_ceiling<>reservation_ceiling THEN
    RAISE EXCEPTION 'CREDIT_CHILD_ALLOCATION_ORIGIN_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.guard_credit_budget_allocation_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.budget_allocation_ref,OLD.execution_budget_root_ref,OLD.site_ref,
         OLD.billing_account_ref,OLD.credit_account_ref,OLD.unit,OLD.liability_merchant_account_ref,
         OLD.parent_allocation_ref,OLD.is_root,OLD.audience,OLD.purpose,OLD.surface_ref,
         OLD.operation_ref,OLD.agent_ref,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.budget_allocation_ref,NEW.execution_budget_root_ref,NEW.site_ref,
         NEW.billing_account_ref,NEW.credit_account_ref,NEW.unit,NEW.liability_merchant_account_ref,
         NEW.parent_allocation_ref,NEW.is_root,NEW.audience,NEW.purpose,NEW.surface_ref,
         NEW.operation_ref,NEW.agent_ref,NEW.created_at)
     OR NEW.current_revision<>OLD.current_revision+1
     OR NEW.current_allocation_epoch NOT IN (
       OLD.current_allocation_epoch,
       OLD.current_allocation_epoch+1
     ) THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_HEAD_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.assert_credit_budget_allocation_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  target_allocation_ref UUID;
  current_fact platform.credit_budget_allocation_revision%ROWTYPE;
  active_child_total NUMERIC(38,0);
  target_is_root BOOLEAN;
  target_parent_ref UUID;
BEGIN
  FOR target_allocation_ref IN
    SELECT NEW.budget_allocation_ref
    UNION
    SELECT parent_allocation_ref
    FROM platform.credit_budget_allocation
    WHERE budget_allocation_ref=NEW.budget_allocation_ref AND parent_allocation_ref IS NOT NULL
  LOOP
    SELECT revision.* INTO current_fact
    FROM platform.credit_budget_allocation allocation
    JOIN platform.credit_budget_allocation_revision revision
      ON revision.budget_allocation_ref=allocation.budget_allocation_ref
     AND revision.revision=allocation.current_revision
    WHERE allocation.budget_allocation_ref=target_allocation_ref;
    SELECT COALESCE(sum(child_revision.credit_ceiling),0)
      INTO active_child_total
    FROM platform.credit_budget_allocation child
    JOIN platform.credit_budget_allocation_revision child_revision
      ON child_revision.budget_allocation_ref=child.budget_allocation_ref
     AND child_revision.revision=child.current_revision
    WHERE child.parent_allocation_ref=target_allocation_ref
      AND child_revision.state<>'terminal';
    IF current_fact.budget_allocation_ref IS NULL
       OR current_fact.active_child_reserved_stock<>active_child_total THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_CHILD_STOCK_MISMATCH' USING ERRCODE='23514';
    END IF;
    SELECT is_root,parent_allocation_ref INTO target_is_root,target_parent_ref
    FROM platform.credit_budget_allocation
    WHERE budget_allocation_ref=target_allocation_ref;
    IF current_fact.state='terminal' AND active_child_total<>0 THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_DESCENDANT_STILL_ACTIVE' USING ERRCODE='23514';
    END IF;
    IF current_fact.state='terminal' AND (
      (target_is_root AND current_fact.parent_applied_revision IS NOT NULL)
      OR (NOT target_is_root AND current_fact.parent_applied_revision IS NULL)
    ) THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_TERMINAL_PARENT_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.guard_credit_authorization_segment_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  before_revision platform.credit_budget_allocation_revision%ROWTYPE;
  after_revision platform.credit_budget_allocation_revision%ROWTYPE;
  current_revision BIGINT;
  root_state TEXT;
  hold_state TEXT;
BEGIN
  IF ROW(OLD.authorization_segment_ref,OLD.site_ref,OLD.execution_budget_root_ref,
         OLD.budget_allocation_ref,OLD.credit_hold_ref,OLD.billing_account_ref,
         OLD.credit_account_ref,OLD.unit,OLD.liability_merchant_account_ref,
         OLD.execution_manifest_ref,OLD.rating_policy_revision_ref,OLD.business_operation_key,
         OLD.request_digest,OLD.maximum_amount,OLD.allocation_epoch,
         OLD.prepared_against_allocation_revision,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.authorization_segment_ref,NEW.site_ref,NEW.execution_budget_root_ref,
         NEW.budget_allocation_ref,NEW.credit_hold_ref,NEW.billing_account_ref,
         NEW.credit_account_ref,NEW.unit,NEW.liability_merchant_account_ref,
         NEW.execution_manifest_ref,NEW.rating_policy_revision_ref,NEW.business_operation_key,
         NEW.request_digest,NEW.maximum_amount,NEW.allocation_epoch,
         NEW.prepared_against_allocation_revision,NEW.expires_at,NEW.created_at)
     OR NEW.aggregate_version<>OLD.aggregate_version+1
     OR NEW.fence_epoch<>OLD.fence_epoch+1 THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  IF OLD.state IN ('settled','released','expired')
     OR (OLD.state='reserved' AND NEW.state NOT IN ('committed','released','expired'))
     OR (OLD.state='committed' AND NEW.state NOT IN ('rating_pending','reconciliation_required'))
     OR (OLD.state='rating_pending' AND NEW.state NOT IN ('settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state<>'settled') THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF OLD.state='reserved' AND NEW.state='committed' THEN
    SELECT root.state,hold.state INTO root_state,hold_state
    FROM platform.credit_execution_budget_root root
    JOIN platform.credit_hold hold
      ON hold.credit_hold_ref=root.credit_hold_ref AND hold.site_ref=root.site_ref
    WHERE root.execution_budget_root_ref=NEW.execution_budget_root_ref
      AND root.site_ref=NEW.site_ref;
    IF root_state IS DISTINCT FROM 'open' OR hold_state IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'CREDIT_AUTHORIZATION_ROOT_NOT_OPEN' USING ERRCODE='23514';
    END IF;
    IF NEW.committed_at IS NULL OR NEW.committed_at>=OLD.expires_at THEN
      RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_EXPIRED' USING ERRCODE='23514';
    END IF;
    IF NEW.committed_from_allocation_revision IS NULL
       OR NEW.committed_to_allocation_revision<>NEW.committed_from_allocation_revision+1
       OR NEW.committed_at IS NULL THEN
      RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_COMMIT_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT * INTO before_revision
    FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.budget_allocation_ref
      AND revision=NEW.committed_from_allocation_revision;
    SELECT * INTO after_revision
    FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.budget_allocation_ref
      AND revision=NEW.committed_to_allocation_revision;
    SELECT allocation.current_revision INTO current_revision
    FROM platform.credit_budget_allocation allocation
    WHERE allocation.budget_allocation_ref=NEW.budget_allocation_ref;
    IF before_revision.budget_allocation_ref IS NULL
       OR after_revision.budget_allocation_ref IS NULL
       OR current_revision<>NEW.committed_to_allocation_revision
       OR before_revision.allocation_epoch<>NEW.allocation_epoch
       OR after_revision.allocation_epoch<>NEW.allocation_epoch
       OR after_revision.credit_ceiling<>before_revision.credit_ceiling
       OR after_revision.unassigned_stock<>before_revision.unassigned_stock-NEW.maximum_amount
       OR after_revision.committed_stock<>before_revision.committed_stock+NEW.maximum_amount
       OR after_revision.active_child_reserved_stock<>before_revision.active_child_reserved_stock
       OR after_revision.captured_cumulative<>before_revision.captured_cumulative
       OR after_revision.returned_to_parent_cumulative<>before_revision.returned_to_parent_cumulative THEN
      RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_COMMIT_STOCK_INVALID' USING ERRCODE='23514';
    END IF;
  ELSIF ROW(NEW.committed_from_allocation_revision,NEW.committed_to_allocation_revision)
        IS DISTINCT FROM ROW(OLD.committed_from_allocation_revision,OLD.committed_to_allocation_revision) THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_COMMIT_REVISION_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.state='expired' AND (NEW.resolution_kind<>'reservation_expiry' OR now()<OLD.expires_at) THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_EXPIRY_INVALID' USING ERRCODE='23514';
  ELSIF NEW.state='released' AND NEW.resolution_kind<>'not_dispatched' THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_RELEASE_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  ELSIF NEW.state='reconciliation_required' AND NEW.resolution_kind<>'outcome_unknown' THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_RECONCILIATION_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  ELSIF NEW.state='settled' AND NEW.resolution_kind NOT IN ('rated','reconciled') THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_SETTLEMENT_EVIDENCE_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.assert_credit_authorization_segment_capacity() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  current_unassigned NUMERIC(38,0);
  reserved_total NUMERIC(38,0);
BEGIN
  SELECT revision.unassigned_stock INTO current_unassigned
  FROM platform.credit_budget_allocation allocation
  JOIN platform.credit_budget_allocation_revision revision
    ON revision.budget_allocation_ref=allocation.budget_allocation_ref
   AND revision.revision=allocation.current_revision
  WHERE allocation.budget_allocation_ref=NEW.budget_allocation_ref;
  SELECT COALESCE(sum(maximum_amount),0) INTO reserved_total
  FROM platform.credit_authorization_segment
  WHERE budget_allocation_ref=NEW.budget_allocation_ref AND state='reserved';
  IF current_unassigned IS NULL OR reserved_total>current_unassigned THEN
    RAISE EXCEPTION 'CREDIT_AUTHORIZATION_SEGMENT_CAPACITY_EXCEEDED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.assert_credit_hold_terminal_segments_closed() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.state IN ('settled','released','expired') AND EXISTS (
    SELECT 1 FROM platform.credit_authorization_segment segment
    WHERE segment.credit_hold_ref=NEW.credit_hold_ref
      AND segment.state NOT IN ('settled','released','expired')
  ) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_SEGMENT_STILL_ACTIVE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.assert_credit_allocation_receipt_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  parent_before platform.credit_budget_allocation_revision%ROWTYPE;
  parent_after platform.credit_budget_allocation_revision%ROWTYPE;
  child_fact platform.credit_budget_allocation_revision%ROWTYPE;
  child_parent_ref UUID;
BEGIN
  IF TG_TABLE_NAME='credit_allocation_reservation_receipt' THEN
    SELECT * INTO parent_before FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_expected_revision;
    SELECT * INTO parent_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_resulting_revision;
    SELECT * INTO child_fact FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.child_allocation_ref AND revision=NEW.child_initial_revision;
    SELECT parent_allocation_ref INTO child_parent_ref FROM platform.credit_budget_allocation
    WHERE budget_allocation_ref=NEW.child_allocation_ref;
    IF parent_before.budget_allocation_ref IS NULL
       OR parent_after.budget_allocation_ref IS NULL
       OR child_fact.budget_allocation_ref IS NULL
       OR child_parent_ref IS DISTINCT FROM NEW.parent_allocation_ref
       OR parent_after.credit_ceiling<>parent_before.credit_ceiling
       OR parent_after.unassigned_stock<>parent_before.unassigned_stock-NEW.reserved_ceiling
       OR parent_after.active_child_reserved_stock<>parent_before.active_child_reserved_stock+NEW.reserved_ceiling
       OR parent_after.committed_stock<>parent_before.committed_stock
       OR parent_after.captured_cumulative<>parent_before.captured_cumulative
       OR parent_after.returned_to_parent_cumulative<>parent_before.returned_to_parent_cumulative
       OR child_fact.credit_ceiling<>NEW.reserved_ceiling
       OR child_fact.unassigned_stock<>NEW.reserved_ceiling
       OR child_fact.active_child_reserved_stock<>0
       OR child_fact.committed_stock<>0
       OR child_fact.captured_cumulative<>0
       OR child_fact.returned_to_parent_cumulative<>0
       OR child_fact.state<>'active' THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_RESERVATION_CONSERVATION_FAILED' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO parent_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_resulting_revision;
    SELECT * INTO parent_before FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_resulting_revision-1;
    SELECT * INTO child_fact FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.child_allocation_ref AND revision=NEW.child_terminal_revision;
    SELECT parent_allocation_ref INTO child_parent_ref FROM platform.credit_budget_allocation
    WHERE budget_allocation_ref=NEW.child_allocation_ref;
    IF parent_before.budget_allocation_ref IS NULL
       OR parent_after.budget_allocation_ref IS NULL
       OR child_fact.budget_allocation_ref IS NULL
       OR child_parent_ref IS DISTINCT FROM NEW.parent_allocation_ref
       OR child_fact.state<>'terminal'
       OR child_fact.unassigned_stock<>0
       OR child_fact.active_child_reserved_stock<>0
       OR child_fact.committed_stock<>0
       OR child_fact.returned_to_parent_cumulative<>NEW.returned_amount
       OR child_fact.captured_cumulative+NEW.returned_amount<>child_fact.credit_ceiling
       OR child_fact.terminal_receipt_digest<>NEW.receipt_digest
       OR child_fact.parent_applied_revision<>NEW.parent_resulting_revision
       OR parent_after.credit_ceiling<>parent_before.credit_ceiling
       OR parent_after.unassigned_stock<>parent_before.unassigned_stock+NEW.returned_amount
       OR parent_after.active_child_reserved_stock<>parent_before.active_child_reserved_stock-child_fact.credit_ceiling
       OR parent_after.committed_stock<>parent_before.committed_stock
       OR parent_after.captured_cumulative<>parent_before.captured_cumulative+child_fact.captured_cumulative
       OR parent_after.returned_to_parent_cumulative<>parent_before.returned_to_parent_cumulative THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_RETURN_CONSERVATION_FAILED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION platform.guard_credit_execution_budget_root_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.execution_budget_root_ref,OLD.site_ref,OLD.execution_root_ref,OLD.billing_account_ref,
         OLD.credit_account_ref,OLD.unit,OLD.liability_merchant_account_ref,OLD.credit_hold_ref,
         OLD.root_allocation_ref,OLD.authorization_budget_ref,OLD.rating_policy_revision_ref,
         OLD.surface_ref,OLD.capability_key,OLD.agent_ref,OLD.reserved_ceiling,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.execution_budget_root_ref,NEW.site_ref,NEW.execution_root_ref,NEW.billing_account_ref,
         NEW.credit_account_ref,NEW.unit,NEW.liability_merchant_account_ref,NEW.credit_hold_ref,
         NEW.root_allocation_ref,NEW.authorization_budget_ref,NEW.rating_policy_revision_ref,
         NEW.surface_ref,NEW.capability_key,NEW.agent_ref,NEW.reserved_ceiling,NEW.created_at)
     OR NEW.aggregate_version<>OLD.aggregate_version+1 THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_BUDGET_ROOT_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  IF OLD.state='settled'
     OR (OLD.state='open' AND NEW.state NOT IN ('closing','reconciliation_required'))
     OR (OLD.state='closing' AND NEW.state NOT IN ('settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state NOT IN ('closing','settled')) THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_BUDGET_ROOT_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_credit_hold_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.credit_hold_ref,OLD.credit_account_ref,OLD.site_ref,OLD.execution_root_ref,
         OLD.unit,OLD.requested_amount,OLD.reserved_amount,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.credit_hold_ref,NEW.credit_account_ref,NEW.site_ref,NEW.execution_root_ref,
         NEW.unit,NEW.requested_amount,NEW.reserved_amount,NEW.expires_at,NEW.created_at)
     OR NEW.fence_epoch<>OLD.fence_epoch+1 THEN
    RAISE EXCEPTION 'CREDIT_HOLD_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.captured_amount<OLD.captured_amount OR NEW.released_amount<OLD.released_amount
     OR OLD.state IN ('settled','released','expired')
     OR (OLD.state='open' AND NEW.state NOT IN ('open','closing','released','expired','reconciliation_required'))
     OR (OLD.state='closing' AND NEW.state NOT IN ('closing','settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state NOT IN ('reconciliation_required','closing','settled')) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.state IN ('released','expired') THEN
    IF NEW.state='expired' AND (NEW.resolution_kind<>'reservation_expiry' OR now()<OLD.expires_at) THEN
      RAISE EXCEPTION 'CREDIT_HOLD_TTL_RELEASE_INVALID' USING ERRCODE='23514';
    ELSIF NEW.state='released' AND NEW.resolution_kind<>'known_outcome' THEN
      RAISE EXCEPTION 'CREDIT_HOLD_RELEASE_EVIDENCE_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commerce_output_plan_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_output_plan
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_actual_output_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_actual_output
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_fulfillment_transaction_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_transaction
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
CREATE TRIGGER commerce_subscription_term_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_subscription_term
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_subscription_term_revocation_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_subscription_term_revocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_entitlement_grant_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_entitlement_grant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_entitlement_revocation_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_entitlement_revocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_command_outbox_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_command_outbox
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_audit_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_audit_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_code_batch_approval_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_code_batch_approval
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_code_secret_export_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_code_secret_export
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE CONSTRAINT TRIGGER commerce_output_plan_contiguous
  AFTER INSERT ON platform.commerce_fulfillment_output_plan
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_commerce_output_plan_contiguous();
CREATE TRIGGER commerce_command_update_guard
  BEFORE UPDATE ON platform.commerce_command
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_command_update();
CREATE CONSTRAINT TRIGGER commerce_fulfillment_committed
  AFTER INSERT ON platform.commerce_fulfillment_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_commerce_fulfillment_committed();
CREATE TRIGGER commerce_code_transition
  BEFORE UPDATE ON platform.commerce_redeem_code
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_code_transition();
CREATE TRIGGER commerce_preview_transition
  BEFORE UPDATE ON platform.commerce_redemption_preview
  FOR EACH ROW EXECUTE FUNCTION platform.guard_commerce_preview_transition();
CREATE TRIGGER credit_grant_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_grant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_hold_no_delete
  BEFORE DELETE ON platform.credit_hold
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_credit_program_window_acquisition_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_credit_program_window_acquisition
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_credit_program_enrollment_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_credit_program_enrollment
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_credit_program_enrollment_revocation_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_credit_program_enrollment_revocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_hold_allocation_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_hold_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_journal_transaction_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_journal_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_journal_entry_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_journal_entry
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_budget_allocation_revision_advance
  BEFORE INSERT ON platform.credit_budget_allocation_revision
  FOR EACH ROW EXECUTE FUNCTION platform.advance_credit_budget_allocation_revision();
CREATE TRIGGER credit_budget_allocation_update_guard
  BEFORE UPDATE ON platform.credit_budget_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_budget_allocation_update();
CREATE TRIGGER credit_budget_allocation_no_delete
  BEFORE DELETE ON platform.credit_budget_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_budget_allocation_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_budget_allocation_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_allocation_reservation_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_allocation_reservation_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_allocation_return_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_allocation_return_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE CONSTRAINT TRIGGER credit_journal_transaction_balanced_from_transaction
  AFTER INSERT ON platform.credit_journal_transaction
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_transaction_balanced();
CREATE CONSTRAINT TRIGGER credit_journal_transaction_balanced_from_entry
  AFTER INSERT ON platform.credit_journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_transaction_balanced();
CREATE CONSTRAINT TRIGGER credit_journal_cross_fact_from_grant
  AFTER INSERT ON platform.credit_grant
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_cross_fact_conservation();
CREATE CONSTRAINT TRIGGER credit_journal_cross_fact_from_hold
  AFTER INSERT OR UPDATE ON platform.credit_hold
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_cross_fact_conservation();
CREATE CONSTRAINT TRIGGER credit_journal_cross_fact_from_hold_allocation
  AFTER INSERT ON platform.credit_hold_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_cross_fact_conservation();
CREATE CONSTRAINT TRIGGER credit_journal_cross_fact_from_entry
  AFTER INSERT ON platform.credit_journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_journal_cross_fact_conservation();
CREATE CONSTRAINT TRIGGER credit_budget_allocation_conservation
  AFTER INSERT ON platform.credit_budget_allocation_revision
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_budget_allocation_conservation();
CREATE CONSTRAINT TRIGGER credit_budget_allocation_origin_from_allocation
  AFTER INSERT ON platform.credit_budget_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_allocation_origin_and_root();
CREATE CONSTRAINT TRIGGER credit_budget_allocation_origin_from_revision
  AFTER INSERT ON platform.credit_budget_allocation_revision
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_allocation_origin_and_root();
CREATE CONSTRAINT TRIGGER credit_budget_allocation_origin_from_reservation
  AFTER INSERT ON platform.credit_allocation_reservation_receipt
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_allocation_origin_and_root();
CREATE CONSTRAINT TRIGGER credit_allocation_reservation_receipt_conservation
  AFTER INSERT ON platform.credit_allocation_reservation_receipt
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_allocation_receipt_conservation();
CREATE CONSTRAINT TRIGGER credit_allocation_return_receipt_conservation
  AFTER INSERT ON platform.credit_allocation_return_receipt
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_allocation_receipt_conservation();
CREATE CONSTRAINT TRIGGER credit_hold_fully_allocated_from_hold
  AFTER INSERT ON platform.credit_hold
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_hold_fully_allocated();
CREATE CONSTRAINT TRIGGER credit_hold_fully_allocated_from_allocation
  AFTER INSERT ON platform.credit_hold_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_hold_fully_allocated();
CREATE TRIGGER credit_hold_transition
  BEFORE UPDATE ON platform.credit_hold
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_hold_transition();
CREATE CONSTRAINT TRIGGER credit_hold_terminal_segments_closed
  AFTER UPDATE ON platform.credit_hold
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_hold_terminal_segments_closed();
CREATE TRIGGER credit_execution_budget_root_transition
  BEFORE UPDATE ON platform.credit_execution_budget_root
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_execution_budget_root_transition();
CREATE TRIGGER credit_execution_budget_root_no_delete
  BEFORE DELETE ON platform.credit_execution_budget_root
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_authorization_segment_transition
  BEFORE UPDATE ON platform.credit_authorization_segment
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_authorization_segment_transition();
CREATE TRIGGER credit_authorization_segment_no_delete
  BEFORE DELETE ON platform.credit_authorization_segment
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER credit_budget_operation_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_budget_operation_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE CONSTRAINT TRIGGER credit_authorization_segment_capacity
  AFTER INSERT OR UPDATE ON platform.credit_authorization_segment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_authorization_segment_capacity();

REVOKE ALL ON
  platform.commerce_command,
  platform.commerce_catalog_epoch_authority,
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
  platform.commerce_subscription_term_revocation,
  platform.commerce_code_batch,
  platform.commerce_redeem_code,
  platform.commerce_code_batch_approval,
  platform.commerce_code_secret_export,
  platform.commerce_redemption,
  platform.commerce_redemption_preview,
  platform.commerce_redemption_legal_acceptance,
  platform.commerce_entitlement_grant,
  platform.commerce_entitlement_revocation,
  platform.commerce_credit_program_enrollment,
  platform.commerce_credit_program_enrollment_revocation,
  platform.credit_account,
  platform.credit_grant,
  platform.commerce_credit_program_window_acquisition,
  platform.credit_hold,
  platform.credit_hold_allocation,
  platform.credit_journal_transaction,
  platform.credit_journal_entry,
  platform.credit_execution_budget_root,
  platform.credit_budget_allocation,
  platform.credit_budget_allocation_revision,
  platform.credit_allocation_reservation_receipt,
  platform.credit_allocation_return_receipt,
  platform.credit_authorization_segment,
  platform.credit_budget_operation_receipt,
  platform.commerce_fulfillment_transaction,
  platform.commerce_fulfillment_output_plan,
  platform.commerce_fulfillment_actual_output,
  platform.commerce_command_outbox,
  platform.commerce_audit_entry
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.valid_credit_scope_policy(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.commerce_safe_label_is_valid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.commerce_iana_zone_is_valid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_commerce_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_commerce_output_plan_contiguous() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_command_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_commerce_fulfillment_committed() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_code_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_commerce_preview_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_journal_transaction_balanced() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_hold_fully_allocated() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_journal_cross_fact_conservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.advance_credit_budget_allocation_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_allocation_origin_and_root() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_budget_allocation_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_budget_allocation_conservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_authorization_segment_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_authorization_segment_capacity() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_hold_terminal_segments_closed() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_allocation_receipt_conservation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_execution_budget_root_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_hold_transition() FROM PUBLIC;

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema='platform' AND column_name='site_ref'
      AND (table_name LIKE 'commerce\_%' ESCAPE '\' OR table_name LIKE 'credit\_%' ESCAPE '\')
    ORDER BY table_name
  LOOP
    EXECUTE format('ALTER TABLE platform.%I ENABLE ROW LEVEL SECURITY',target.table_name);
    EXECUTE format('ALTER TABLE platform.%I FORCE ROW LEVEL SECURITY',target.table_name);
    EXECUTE format(
      'CREATE POLICY site_isolation ON platform.%I USING (site_ref=current_setting(''app.site_id'',true)) WITH CHECK (site_ref=current_setting(''app.site_id'',true))',
      target.table_name
    );
  END LOOP;
END $$;

ALTER TABLE platform.commerce_fulfillment_output_plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.commerce_fulfillment_output_plan FORCE ROW LEVEL SECURITY;
CREATE POLICY site_isolation ON platform.commerce_fulfillment_output_plan
  USING (EXISTS (SELECT 1 FROM platform.commerce_fulfillment_transaction parent
    WHERE parent.fulfillment_id=commerce_fulfillment_output_plan.fulfillment_id
      AND parent.site_ref=current_setting('app.site_id',true)))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.commerce_fulfillment_transaction parent
    WHERE parent.fulfillment_id=commerce_fulfillment_output_plan.fulfillment_id
      AND parent.site_ref=current_setting('app.site_id',true)));

ALTER TABLE platform.commerce_fulfillment_actual_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.commerce_fulfillment_actual_output FORCE ROW LEVEL SECURITY;
CREATE POLICY site_isolation ON platform.commerce_fulfillment_actual_output
  USING (EXISTS (SELECT 1 FROM platform.commerce_fulfillment_transaction parent
    WHERE parent.fulfillment_id=commerce_fulfillment_actual_output.fulfillment_id
      AND parent.site_ref=current_setting('app.site_id',true)))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.commerce_fulfillment_transaction parent
    WHERE parent.fulfillment_id=commerce_fulfillment_actual_output.fulfillment_id
      AND parent.site_ref=current_setting('app.site_id',true)));

ALTER TABLE platform.commerce_command_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.commerce_command_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY site_isolation ON platform.commerce_command_outbox
  USING (EXISTS (SELECT 1 FROM platform.commerce_command parent
    WHERE parent.command_id=commerce_command_outbox.command_id
      AND parent.site_ref=current_setting('app.site_id',true)))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.commerce_command parent
    WHERE parent.command_id=commerce_command_outbox.command_id
      AND parent.site_ref=current_setting('app.site_id',true)));
