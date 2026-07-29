SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admin_operator_authority (
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active','suspended')),
  permissions TEXT[] NOT NULL CHECK (cardinality(permissions) > 0),
  site_scopes TEXT[] NOT NULL,
  environments TEXT[] NOT NULL CHECK (cardinality(environments) > 0),
  regions TEXT[] NOT NULL CHECK (cardinality(regions) > 0),
  authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  break_glass_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(operator_ref,operator_generation),
  CHECK (expires_at > created_at),
  CHECK (break_glass_expires_at IS NULL OR break_glass_expires_at <= expires_at)
);
CREATE INDEX admin_operator_authority_state_idx
  ON platform.admin_operator_authority(state,expires_at);

CREATE TABLE platform.admin_command_decision (
  decision_ref UUID PRIMARY KEY,
  command_id TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  operation TEXT NOT NULL,
  target_site_ref TEXT,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK (effect_class IN ('read','mutation','dangerous','break_glass')),
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('none','pre_effect','post_effect_review')),
  operator_reason TEXT,
  break_glass_ticket_ref TEXT,
  authorization_epoch BIGINT CHECK (authorization_epoch > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((allowed AND authorization_epoch IS NOT NULL) OR NOT allowed),
  CHECK (
    (effect_class='break_glass' AND (NOT allowed OR break_glass_ticket_ref IS NOT NULL))
    OR (effect_class<>'break_glass' AND break_glass_ticket_ref IS NULL)
  )
);
CREATE INDEX admin_command_decision_operator_time_idx
  ON platform.admin_command_decision(operator_ref,occurred_at);
CREATE INDEX admin_command_decision_site_time_idx
  ON platform.admin_command_decision(target_site_ref,occurred_at);

CREATE TABLE platform.admin_approval (
  approval_ref UUID PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  payload JSONB NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL,
  maker_ref TEXT NOT NULL,
  maker_generation BIGINT NOT NULL CHECK (maker_generation > 0),
  maker_authorization_epoch BIGINT NOT NULL CHECK (maker_authorization_epoch > 0),
  target_site_ref TEXT,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  effect_class TEXT NOT NULL CHECK (effect_class='dangerous'),
  approval_policy TEXT NOT NULL CHECK (approval_policy='pre_effect'),
  operator_reason TEXT NOT NULL,
  admitted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','executed','rejected','effect_rejected','expired')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  checker_ref TEXT,
  checker_generation BIGINT CHECK (checker_generation > 0),
  checker_authorization_epoch BIGINT CHECK (checker_authorization_epoch > 0),
  checker_decision TEXT CHECK (checker_decision IN ('approve','reject')),
  checker_reason TEXT,
  result JSONB,
  result_digest CHAR(64) CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(maker_ref,maker_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > admitted_at),
  CHECK (
    (state='pending' AND checker_ref IS NULL AND checker_generation IS NULL AND
      checker_authorization_epoch IS NULL AND checker_decision IS NULL AND checker_reason IS NULL AND
      result IS NULL AND result_digest IS NULL AND decided_at IS NULL)
    OR
    (state<>'pending' AND checker_ref IS NOT NULL AND checker_generation IS NOT NULL AND
      checker_authorization_epoch IS NOT NULL AND checker_decision IS NOT NULL AND checker_reason IS NOT NULL AND
      result IS NOT NULL AND result_digest IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (checker_ref IS NULL OR checker_ref<>maker_ref)
);
CREATE INDEX admin_approval_queue_idx
  ON platform.admin_approval(environment,region,target_site_ref,state,expires_at);

CREATE TABLE platform.admin_approval_decision (
  decision_ref UUID PRIMARY KEY,
  approval_ref TEXT NOT NULL,
  execution_command_id TEXT NOT NULL,
  checker_ref TEXT NOT NULL,
  checker_generation BIGINT NOT NULL CHECK (checker_generation > 0),
  checker_authorization_epoch BIGINT CHECK (checker_authorization_epoch > 0),
  target_site_ref TEXT,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reason_code TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((allowed AND checker_authorization_epoch IS NOT NULL) OR NOT allowed)
);
CREATE INDEX admin_approval_decision_ref_time_idx
  ON platform.admin_approval_decision(approval_ref,occurred_at);

CREATE FUNCTION platform.reject_admin_immutable_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'ADMIN_IMMUTABLE_FACT' USING ERRCODE='23000';
END $$;

CREATE FUNCTION platform.guard_admin_approval_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF OLD.state<>'pending' OR NEW.state='pending' OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF ROW(OLD.approval_ref,OLD.command_id,OLD.request_digest,OLD.payload,OLD.payload_digest,
         OLD.operation,OLD.maker_ref,OLD.maker_generation,OLD.maker_authorization_epoch,
         OLD.target_site_ref,OLD.environment,OLD.region,OLD.effect_class,OLD.approval_policy,
         OLD.operator_reason,OLD.admitted_at,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.approval_ref,NEW.command_id,NEW.request_digest,NEW.payload,NEW.payload_digest,
         NEW.operation,NEW.maker_ref,NEW.maker_generation,NEW.maker_authorization_epoch,
         NEW.target_site_ref,NEW.environment,NEW.region,NEW.effect_class,NEW.approval_policy,
         NEW.operator_reason,NEW.admitted_at,NEW.expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_REQUEST_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_command_decision_immutable
  BEFORE UPDATE OR DELETE ON platform.admin_command_decision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();
CREATE TRIGGER admin_approval_decision_immutable
  BEFORE UPDATE OR DELETE ON platform.admin_approval_decision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();
CREATE TRIGGER admin_approval_transition_guard
  BEFORE UPDATE ON platform.admin_approval
  FOR EACH ROW EXECUTE FUNCTION platform.guard_admin_approval_transition();
CREATE TRIGGER admin_approval_no_delete
  BEFORE DELETE ON platform.admin_approval
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();

ALTER TABLE platform.admin_operator_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_command_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_command_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval_decision FORCE ROW LEVEL SECURITY;

CREATE POLICY admin_operator_authority_control_plane
  ON platform.admin_operator_authority FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND (
      operator_ref=current_setting('app.subject_id',true)
      OR current_setting('app.operation',true)='admin.approval.execute'
    )
  );
CREATE POLICY admin_command_decision_insert
  ON platform.admin_command_decision FOR INSERT
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
  );
CREATE POLICY admin_approval_site_control_plane
  ON platform.admin_approval
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
    AND current_setting('app.operation',true)='admin.approval.execute'
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
    AND (
      (state='pending' AND maker_ref=current_setting('app.subject_id',true)
        AND operation=current_setting('app.operation',true))
      OR
      (state<>'pending' AND checker_ref=current_setting('app.subject_id',true)
        AND current_setting('app.operation',true)='admin.approval.execute')
    )
  );
CREATE POLICY admin_approval_decision_insert
  ON platform.admin_approval_decision FOR INSERT
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND checker_ref=current_setting('app.subject_id',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
    AND current_setting('app.operation',true)='admin.approval.execute'
  );

REVOKE ALL ON
  platform.admin_operator_authority,
  platform.admin_command_decision,
  platform.admin_approval,
  platform.admin_approval_decision
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_admin_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_admin_approval_transition() FROM PUBLIC;
