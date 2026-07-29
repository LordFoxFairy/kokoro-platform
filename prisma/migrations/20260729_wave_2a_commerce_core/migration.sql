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

ALTER TABLE platform.authorization_subject
  ADD CONSTRAINT authorization_subject_site_identity UNIQUE(subject_ref,site_ref);
ALTER TABLE platform.authorization_identity_session
  ADD CONSTRAINT authorization_session_subject_site_identity UNIQUE(session_ref,subject_ref,site_ref);

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

CREATE TRIGGER commerce_output_plan_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_output_plan
  FOR EACH ROW EXECUTE FUNCTION platform.reject_commerce_immutable_mutation();
CREATE TRIGGER commerce_actual_output_immutable
  BEFORE UPDATE OR DELETE ON platform.commerce_fulfillment_actual_output
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

REVOKE ALL ON
  platform.commerce_command,
  platform.commerce_billing_account,
  platform.commerce_billing_account_membership,
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
