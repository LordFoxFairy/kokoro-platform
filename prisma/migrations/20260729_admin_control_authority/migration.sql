SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admin_operator_authority (
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active','suspended','revoked')),
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

CREATE TABLE platform.admin_authority_bootstrap (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed')),
  configuration_digest CHAR(64) CHECK (configuration_digest IS NULL OR configuration_digest ~ '^[a-f0-9]{64}$'),
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state='open' AND configuration_digest IS NULL AND sealed_at IS NULL) OR
         (state='sealed' AND configuration_digest IS NOT NULL AND sealed_at IS NOT NULL))
);
INSERT INTO platform.admin_authority_bootstrap(singleton) VALUES(TRUE);

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
    CHECK (state IN ('pending','execution_queued','executed','rejected','effect_rejected','expired','stale_authority')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  checker_ref TEXT,
  checker_generation BIGINT CHECK (checker_generation > 0),
  checker_authorization_epoch BIGINT CHECK (checker_authorization_epoch > 0),
  checker_decision TEXT CHECK (checker_decision IN ('approve','reject')),
  checker_reason TEXT,
  result JSONB,
  result_digest CHAR(64) CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  terminal_reason TEXT,
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
    (state IN ('execution_queued','executed','rejected','effect_rejected') AND
      checker_ref IS NOT NULL AND checker_generation IS NOT NULL AND
      checker_authorization_epoch IS NOT NULL AND checker_decision IS NOT NULL AND checker_reason IS NOT NULL AND
      result IS NOT NULL AND result_digest IS NOT NULL AND decided_at IS NOT NULL)
    OR
    (state IN ('expired','stale_authority') AND terminal_reason IS NOT NULL AND
      result IS NOT NULL AND result_digest IS NOT NULL)
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

CREATE TABLE platform.admin_post_effect_review (
  review_ref UUID PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  operation TEXT NOT NULL,
  maker_ref TEXT NOT NULL,
  maker_generation BIGINT NOT NULL CHECK (maker_generation > 0),
  maker_authorization_epoch BIGINT NOT NULL CHECK (maker_authorization_epoch > 0),
  target_site_ref TEXT,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  break_glass_ticket_ref TEXT NOT NULL,
  outcome JSONB NOT NULL,
  outcome_digest CHAR(64) NOT NULL CHECK (outcome_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','acknowledged','escalated','expired')),
  reviewer_ref TEXT,
  reviewer_generation BIGINT CHECK (reviewer_generation > 0),
  reviewer_authorization_epoch BIGINT CHECK (reviewer_authorization_epoch > 0),
  reviewer_reason TEXT,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY(maker_ref,maker_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > created_at),
  CHECK ((state='pending' AND reviewer_ref IS NULL AND terminal_reason IS NULL AND reviewed_at IS NULL) OR
         (state IN ('acknowledged','escalated') AND reviewer_ref IS NOT NULL AND
          reviewer_generation IS NOT NULL AND reviewer_reason IS NOT NULL AND
          terminal_reason IS NULL AND reviewed_at IS NOT NULL) OR
         (state='expired' AND reviewer_ref IS NULL AND terminal_reason IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (reviewer_ref IS NULL OR reviewer_ref<>maker_ref)
);
CREATE INDEX admin_post_effect_review_queue_idx
  ON platform.admin_post_effect_review(environment,region,target_site_ref,state,expires_at);

CREATE FUNCTION platform.reject_admin_immutable_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'ADMIN_IMMUTABLE_FACT' USING ERRCODE='23000';
END $$;

CREATE FUNCTION platform.bootstrap_admin_authorities(
  p_authorities JSONB,
  p_configuration_digest CHAR(64)
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  bootstrap platform.admin_authority_bootstrap%ROWTYPE;
  inserted_count INTEGER;
BEGIN
  PERFORM set_config('app.admin_bootstrap','true',true);
  SELECT * INTO bootstrap FROM platform.admin_authority_bootstrap WHERE singleton IS TRUE FOR UPDATE;
  IF bootstrap.state<>'open' THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_SEALED' USING ERRCODE='55000';
  END IF;
  IF p_configuration_digest IS NULL OR p_configuration_digest !~ '^[a-f0-9]{64}$'
     OR encode(sha256(convert_to(p_authorities::TEXT,'UTF8')),'hex')<>p_configuration_digest
     OR jsonb_typeof(p_authorities)<>'array'
     OR jsonb_array_length(p_authorities)<2 OR jsonb_array_length(p_authorities)>16 THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_authorities) AS item
    WHERE jsonb_typeof(item)<>'object'
       OR item-ARRAY['operatorRef','operatorGeneration','permissions','siteScopes','environments',
                     'regions','authorizationEpoch','expiresAt','breakGlassExpiresAt']::TEXT[]<>'{}'::JSONB
       OR COALESCE(item->>'operatorRef','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
       OR COALESCE(item->>'operatorGeneration','') !~ '^[1-9][0-9]*$'
       OR COALESCE(item->>'authorizationEpoch','') !~ '^[1-9][0-9]*$'
       OR jsonb_typeof(item->'permissions')<>'array'
       OR NOT (item->'permissions' ?& ARRAY['admin.approval.execute','admin.authority.manage'])
       OR jsonb_typeof(item->'siteScopes')<>'array'
       OR jsonb_typeof(item->'environments')<>'array'
       OR jsonb_array_length(item->'environments')<1
       OR jsonb_typeof(item->'regions')<>'array'
       OR jsonb_array_length(item->'regions')<1
       OR COALESCE(item->>'expiresAt','')::TIMESTAMPTZ<=now()
  ) OR (
    SELECT count(*)<>count(DISTINCT item->>'operatorRef')
    FROM jsonb_array_elements(p_authorities) AS item
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  INSERT INTO platform.admin_operator_authority(
    operator_ref,operator_generation,state,permissions,site_scopes,environments,regions,
    authorization_epoch,expires_at,break_glass_expires_at
  )
  SELECT item->>'operatorRef',(item->>'operatorGeneration')::BIGINT,'active',
    ARRAY(SELECT jsonb_array_elements_text(item->'permissions')),
    ARRAY(SELECT jsonb_array_elements_text(item->'siteScopes')),
    ARRAY(SELECT jsonb_array_elements_text(item->'environments')),
    ARRAY(SELECT jsonb_array_elements_text(item->'regions')),
    (item->>'authorizationEpoch')::BIGINT,(item->>'expiresAt')::TIMESTAMPTZ,
    CASE WHEN item->'breakGlassExpiresAt'='null'::JSONB THEN NULL
         ELSE (item->>'breakGlassExpiresAt')::TIMESTAMPTZ END
  FROM jsonb_array_elements(p_authorities) AS item;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  UPDATE platform.admin_authority_bootstrap
    SET state='sealed',configuration_digest=p_configuration_digest,sealed_at=now()
    WHERE singleton IS TRUE AND state='open';
  RETURN inserted_count;
END $$;

CREATE FUNCTION platform.guard_admin_approval_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.revision<>OLD.revision+1 OR NOT (
       (OLD.state='pending' AND NEW.state IN ('execution_queued','rejected','expired','stale_authority'))
       OR
       (OLD.state='execution_queued' AND NEW.state IN ('executed','effect_rejected','stale_authority'))
     ) THEN
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
  IF OLD.state='execution_queued' AND ROW(
       OLD.checker_ref,OLD.checker_generation,OLD.checker_authorization_epoch,
       OLD.checker_decision,OLD.checker_reason,OLD.decided_at
     ) IS DISTINCT FROM ROW(
       NEW.checker_ref,NEW.checker_generation,NEW.checker_authorization_epoch,
       NEW.checker_decision,NEW.checker_reason,NEW.decided_at
     ) THEN
    RAISE EXCEPTION 'ADMIN_APPROVAL_CHECKER_EVIDENCE_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.apply_admin_authority_change(
  p_approval_ref UUID,
  p_change JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  approval_row platform.admin_approval%ROWTYPE;
  authority_row platform.admin_operator_authority%ROWTYPE;
  action_name TEXT;
  operator_name TEXT;
  generation BIGINT;
  expected_epoch BIGINT;
  next_epoch BIGINT;
  governor_count INTEGER;
BEGIN
  IF current_setting('app.workload_kind',true)<>'platform_worker'
     OR current_setting('app.admin_execution',true)<>'true'
     OR current_setting('app.operation',true)<>'admin.authority.change' THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_EXECUTION_CONTEXT_INVALID' USING ERRCODE='42501';
  END IF;
  SELECT * INTO approval_row FROM platform.admin_approval
    WHERE approval_ref=p_approval_ref FOR UPDATE;
  IF NOT FOUND OR approval_row.state<>'execution_queued'
     OR approval_row.operation<>'admin.authority.change'
     OR approval_row.target_site_ref IS NOT NULL
     OR approval_row.checker_decision<>'approve'
     OR approval_row.payload<>p_change
     OR approval_row.maker_ref<>current_setting('app.admin_maker_ref',true)
     OR approval_row.maker_generation::TEXT<>current_setting('app.admin_maker_generation',true)
     OR approval_row.maker_authorization_epoch::TEXT<>
        current_setting('app.admin_maker_authorization_epoch',true)
     OR approval_row.checker_ref<>current_setting('app.subject_id',true)
     OR approval_row.checker_generation::TEXT<>current_setting('app.subject_generation',true)
     OR approval_row.checker_authorization_epoch::TEXT<>
        current_setting('app.admin_checker_authorization_epoch',true) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_APPROVAL_EVIDENCE_INVALID' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_change)<>'object'
     OR COALESCE(p_change->>'action','') NOT IN ('provision','replace','suspend','revoke')
     OR COALESCE(p_change->>'operatorRef','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
     OR COALESCE(p_change->>'operatorGeneration','') !~ '^[1-9][0-9]{0,18}$' THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
  END IF;
  action_name:=p_change->>'action';
  operator_name:=p_change->>'operatorRef';
  generation:=(p_change->>'operatorGeneration')::BIGINT;
  PERFORM set_config('app.admin_authority_function','true',true);

  IF action_name='provision' THEN
    IF p_change-ARRAY['action','operatorRef','operatorGeneration','permissions','siteScopes',
       'environments','regions','expiresAt','breakGlassExpiresAt']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(p_change->'permissions')<>'array'
       OR jsonb_array_length(p_change->'permissions')<1
       OR jsonb_typeof(p_change->'siteScopes')<>'array'
       OR jsonb_array_length(p_change->'siteScopes')<1
       OR jsonb_typeof(p_change->'environments')<>'array'
       OR jsonb_array_length(p_change->'environments')<1
       OR jsonb_typeof(p_change->'regions')<>'array'
       OR jsonb_array_length(p_change->'regions')<1
       OR COALESCE(p_change->>'expiresAt','')::TIMESTAMPTZ<=now() THEN
      RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.admin_operator_authority(
      operator_ref,operator_generation,state,permissions,site_scopes,environments,regions,
      authorization_epoch,expires_at,break_glass_expires_at
    ) VALUES (
      operator_name,generation,'active',
      ARRAY(SELECT jsonb_array_elements_text(p_change->'permissions')),
      ARRAY(SELECT jsonb_array_elements_text(p_change->'siteScopes')),
      ARRAY(SELECT jsonb_array_elements_text(p_change->'environments')),
      ARRAY(SELECT jsonb_array_elements_text(p_change->'regions')),1,
      (p_change->>'expiresAt')::TIMESTAMPTZ,
      CASE WHEN p_change->'breakGlassExpiresAt' IS NULL OR
                     p_change->'breakGlassExpiresAt'='null'::JSONB THEN NULL
           ELSE (p_change->>'breakGlassExpiresAt')::TIMESTAMPTZ END
    );
    next_epoch:=1;
  ELSE
    IF COALESCE(p_change->>'expectedAuthorizationEpoch','') !~ '^[1-9][0-9]{0,18}$' THEN
      RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
    END IF;
    expected_epoch:=(p_change->>'expectedAuthorizationEpoch')::BIGINT;
    SELECT * INTO authority_row FROM platform.admin_operator_authority
      WHERE operator_ref=operator_name AND operator_generation=generation FOR UPDATE;
    IF NOT FOUND OR authority_row.authorization_epoch<>expected_epoch THEN
      RAISE EXCEPTION 'ADMIN_AUTHORITY_EPOCH_CONFLICT' USING ERRCODE='40001';
    END IF;
    next_epoch:=expected_epoch+1;
    IF action_name='replace' THEN
      IF p_change-ARRAY['action','operatorRef','operatorGeneration','expectedAuthorizationEpoch',
         'permissions','siteScopes','environments','regions','expiresAt',
         'breakGlassExpiresAt']::TEXT[]<>'{}'::JSONB
         OR jsonb_typeof(p_change->'permissions')<>'array'
         OR jsonb_array_length(p_change->'permissions')<1
         OR jsonb_typeof(p_change->'siteScopes')<>'array'
         OR jsonb_array_length(p_change->'siteScopes')<1
         OR jsonb_typeof(p_change->'environments')<>'array'
         OR jsonb_array_length(p_change->'environments')<1
         OR jsonb_typeof(p_change->'regions')<>'array'
         OR jsonb_array_length(p_change->'regions')<1
         OR COALESCE(p_change->>'expiresAt','')::TIMESTAMPTZ<=now() THEN
        RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
      END IF;
      UPDATE platform.admin_operator_authority SET state='active',
        permissions=ARRAY(SELECT jsonb_array_elements_text(p_change->'permissions')),
        site_scopes=ARRAY(SELECT jsonb_array_elements_text(p_change->'siteScopes')),
        environments=ARRAY(SELECT jsonb_array_elements_text(p_change->'environments')),
        regions=ARRAY(SELECT jsonb_array_elements_text(p_change->'regions')),
        authorization_epoch=next_epoch,expires_at=(p_change->>'expiresAt')::TIMESTAMPTZ,
        break_glass_expires_at=CASE WHEN p_change->'breakGlassExpiresAt' IS NULL OR
          p_change->'breakGlassExpiresAt'='null'::JSONB THEN NULL
          ELSE (p_change->>'breakGlassExpiresAt')::TIMESTAMPTZ END,
        updated_at=now()
        WHERE operator_ref=operator_name AND operator_generation=generation;
    ELSE
      IF p_change-ARRAY['action','operatorRef','operatorGeneration',
         'expectedAuthorizationEpoch']::TEXT[]<>'{}'::JSONB THEN
        RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
      END IF;
      UPDATE platform.admin_operator_authority
        SET state=CASE WHEN action_name='suspend' THEN 'suspended' ELSE 'revoked' END,
            authorization_epoch=next_epoch,updated_at=now()
        WHERE operator_ref=operator_name AND operator_generation=generation;
    END IF;
  END IF;

  SELECT count(*) INTO governor_count FROM platform.admin_operator_authority
    WHERE state='active' AND expires_at>now()
      AND permissions @> ARRAY['admin.approval.execute','admin.authority.manage']::TEXT[];
  IF governor_count<2 THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_QUORUM_REQUIRED' USING ERRCODE='23000';
  END IF;
  RETURN jsonb_build_object('operatorRef',operator_name,'operatorGeneration',generation::TEXT,
    'state',CASE WHEN action_name='replace' THEN 'active'
                 WHEN action_name='suspend' THEN 'suspended' ELSE action_name END,
    'authorizationEpoch',next_epoch::TEXT);
END $$;

CREATE FUNCTION platform.guard_admin_post_effect_review_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF OLD.state<>'pending' OR NEW.state NOT IN ('acknowledged','escalated','expired')
     OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'ADMIN_POST_EFFECT_REVIEW_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF ROW(OLD.review_ref,OLD.command_id,OLD.request_digest,OLD.operation,OLD.maker_ref,
         OLD.maker_generation,OLD.maker_authorization_epoch,OLD.target_site_ref,
         OLD.environment,OLD.region,OLD.break_glass_ticket_ref,OLD.outcome,
         OLD.outcome_digest,OLD.created_at,OLD.expires_at)
     IS DISTINCT FROM
     ROW(NEW.review_ref,NEW.command_id,NEW.request_digest,NEW.operation,NEW.maker_ref,
         NEW.maker_generation,NEW.maker_authorization_epoch,NEW.target_site_ref,
         NEW.environment,NEW.region,NEW.break_glass_ticket_ref,NEW.outcome,
         NEW.outcome_digest,NEW.created_at,NEW.expires_at) THEN
    RAISE EXCEPTION 'ADMIN_POST_EFFECT_REVIEW_IMMUTABLE' USING ERRCODE='23000';
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
CREATE TRIGGER post_effect_review_no_delete
  BEFORE DELETE ON platform.admin_post_effect_review
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();
CREATE TRIGGER post_effect_review_transition_guard
  BEFORE UPDATE ON platform.admin_post_effect_review
  FOR EACH ROW EXECUTE FUNCTION platform.guard_admin_post_effect_review_transition();

ALTER TABLE platform.admin_operator_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_command_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_command_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_approval_decision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_authority_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_authority_bootstrap FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_post_effect_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_post_effect_review FORCE ROW LEVEL SECURITY;

CREATE POLICY admin_operator_authority_bootstrap_insert
  ON platform.admin_operator_authority FOR INSERT
  WITH CHECK (current_setting('app.admin_bootstrap',true)='true');

CREATE POLICY admin_operator_authority_governed_change
  ON platform.admin_operator_authority FOR ALL
  USING (current_setting('app.admin_authority_function',true)='true')
  WITH CHECK (current_setting('app.admin_authority_function',true)='true');

CREATE POLICY admin_operator_authority_control_plane
  ON platform.admin_operator_authority FOR SELECT
  USING (
    (current_setting('app.workload_kind',true)='admin_workload'
     AND current_setting('app.actor_kind',true)='operator'
     AND (operator_ref=current_setting('app.subject_id',true)
          OR current_setting('app.operation',true)='admin.approval.execute'))
    OR
    (current_setting('app.workload_kind',true)='platform_worker'
     AND (current_setting('app.admin_execution',true)='true'
          OR current_setting('app.operation',true)='admin.terminalize'))
  );
CREATE POLICY admin_command_decision_insert
  ON platform.admin_command_decision FOR INSERT
  WITH CHECK (
    (
      (current_setting('app.workload_kind',true)='admin_workload'
       AND current_setting('app.actor_kind',true)='operator')
      OR
      (current_setting('app.workload_kind',true)='platform_worker'
       AND current_setting('app.admin_execution',true)='true')
    )
    AND operator_ref=current_setting('app.subject_id',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
  );
CREATE POLICY admin_approval_site_control_plane
  ON platform.admin_approval
  USING (
    (((current_setting('app.workload_kind',true)='admin_workload'
       AND current_setting('app.actor_kind',true)='operator')
      OR
      (current_setting('app.workload_kind',true)='platform_worker'
       AND current_setting('app.admin_execution',true)='true'))
     AND environment=current_setting('app.environment',true)
     AND region=current_setting('app.region',true)
     AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
     AND (current_setting('app.operation',true)='admin.approval.execute'
          OR current_setting('app.admin_execution',true)='true'))
    OR
    (current_setting('app.workload_kind',true)='platform_worker'
     AND current_setting('app.operation',true)='admin.terminalize')
  )
  WITH CHECK (
    (((current_setting('app.workload_kind',true)='admin_workload'
       AND current_setting('app.actor_kind',true)='operator')
      OR
      (current_setting('app.workload_kind',true)='platform_worker'
       AND current_setting('app.admin_execution',true)='true'))
     AND environment=current_setting('app.environment',true)
     AND region=current_setting('app.region',true)
     AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
     AND ((state='pending' AND maker_ref=current_setting('app.subject_id',true)
           AND operation=current_setting('app.operation',true))
          OR (state<>'pending' AND checker_ref=current_setting('app.subject_id',true)
              AND current_setting('app.operation',true)='admin.approval.execute')
          OR (state IN ('executed','effect_rejected','stale_authority')
              AND current_setting('app.admin_execution',true)='true')))
    OR
    (state IN ('expired','stale_authority')
     AND current_setting('app.workload_kind',true)='platform_worker'
     AND current_setting('app.operation',true)='admin.terminalize')
  );

CREATE POLICY admin_authority_bootstrap_owner_only
  ON platform.admin_authority_bootstrap
  USING (current_setting('app.admin_bootstrap',true)='true')
  WITH CHECK (current_setting('app.admin_bootstrap',true)='true');
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

CREATE POLICY admin_post_effect_review_control_plane
  ON platform.admin_post_effect_review
  USING (
    (current_setting('app.workload_kind',true)='admin_workload'
     AND current_setting('app.actor_kind',true)='operator'
     AND environment=current_setting('app.environment',true)
     AND region=current_setting('app.region',true)
     AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true))
    OR
    (current_setting('app.workload_kind',true)='platform_worker'
     AND current_setting('app.operation',true)='admin.terminalize')
  )
  WITH CHECK (
    (current_setting('app.workload_kind',true)='admin_workload'
     AND current_setting('app.actor_kind',true)='operator'
     AND environment=current_setting('app.environment',true)
     AND region=current_setting('app.region',true)
     AND COALESCE(target_site_ref,'')=current_setting('app.site_id',true)
     AND ((state='pending' AND maker_ref=current_setting('app.subject_id',true)
           AND operation=current_setting('app.operation',true))
          OR (state<>'pending' AND reviewer_ref=current_setting('app.subject_id',true)
              AND current_setting('app.operation',true)='admin.break-glass.review')))
    OR
    (state='expired' AND current_setting('app.workload_kind',true)='platform_worker'
     AND current_setting('app.operation',true)='admin.terminalize')
  );

REVOKE ALL ON
  platform.admin_operator_authority,
  platform.admin_command_decision,
  platform.admin_approval,
  platform.admin_approval_decision,
  platform.admin_authority_bootstrap,
  platform.admin_post_effect_review
FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.bootstrap_admin_authorities(JSONB, CHAR(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.apply_admin_authority_change(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_admin_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_admin_approval_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_admin_post_effect_review_transition() FROM PUBLIC;
