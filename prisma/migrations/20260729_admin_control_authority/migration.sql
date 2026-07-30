SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admin_operator_authority (
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active','suspended','revoked')),
  permissions TEXT[] NOT NULL CHECK (cardinality(permissions) > 0),
  operator_security_epoch BIGINT NOT NULL CHECK (operator_security_epoch > 0),
  authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(operator_ref,operator_generation),
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_operator_authority_state_idx
  ON platform.admin_operator_authority(state,expires_at);

CREATE TABLE platform.admin_operator_site_scope (
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  site_ref TEXT NOT NULL CHECK (site_ref<>'*' AND length(site_ref) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  scope_epoch BIGINT NOT NULL CHECK (scope_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(operator_ref,operator_generation,site_ref,environment,region),
  FOREIGN KEY(operator_ref,operator_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_operator_site_scope_lookup_idx
  ON platform.admin_operator_site_scope(site_ref,environment,region,state,expires_at);

CREATE TABLE platform.admin_operator_global_scope_grant (
  grant_ref UUID PRIMARY KEY,
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  scope_epoch BIGINT NOT NULL CHECK (scope_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(operator_ref,operator_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_operator_global_scope_lookup_idx
  ON platform.admin_operator_global_scope_grant(
    operator_ref,operator_generation,environment,region,state,expires_at
  );

CREATE TABLE platform.admin_breakglass_grant (
  grant_ref UUID PRIMARY KEY,
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  incident_ref TEXT NOT NULL CHECK (length(incident_ref) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 64),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  authorized_operation TEXT NOT NULL CHECK (length(authorized_operation) BETWEEN 1 AND 128),
  resource_refs TEXT[] NOT NULL CHECK (cardinality(resource_refs) BETWEEN 1 AND 100),
  field_allowlist TEXT[] NOT NULL CHECK (cardinality(field_allowlist) BETWEEN 1 AND 100),
  scope_epoch BIGINT NOT NULL CHECK (scope_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  approved_by_refs TEXT[] NOT NULL CHECK (
    cardinality(approved_by_refs)=2 AND approved_by_refs[1]<>approved_by_refs[2]
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(operator_ref,operator_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 minutes')
);
CREATE INDEX admin_breakglass_grant_lookup_idx
  ON platform.admin_breakglass_grant(
    operator_ref,operator_generation,environment,region,state,expires_at
  );

CREATE TABLE platform.admin_operator_identity (
  identity_ref UUID PRIMARY KEY,
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(issuer,subject),
  FOREIGN KEY(operator_ref,operator_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation)
);
CREATE INDEX admin_operator_identity_authority_idx
  ON platform.admin_operator_identity(operator_ref,operator_generation,state);

CREATE TABLE platform.admin_oidc_transaction (
  transaction_ref UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'pending','redeeming','committed','provider_outcome_unknown','rejected'
  )),
  begin_command_id TEXT NOT NULL UNIQUE,
  begin_idempotency_key TEXT NOT NULL,
  begin_request_digest CHAR(64) NOT NULL CHECK (begin_request_digest ~ '^[a-f0-9]{64}$'),
  workload_identity_ref TEXT NOT NULL,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  managed_device_ref TEXT NOT NULL,
  audience TEXT NOT NULL,
  return_intent_ref TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  oidc_audience TEXT NOT NULL,
  exact_callback_uri TEXT NOT NULL,
  pkce_verifier_ciphertext TEXT NOT NULL,
  pkce_challenge TEXT NOT NULL,
  nonce_ciphertext TEXT NOT NULL,
  state_digest CHAR(64) NOT NULL CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  recovery_digest CHAR(64) NOT NULL CHECK (recovery_digest ~ '^[a-f0-9]{64}$'),
  signing_key_revision TEXT NOT NULL,
  delivery_key_revision TEXT NOT NULL,
  exchange_command_id TEXT UNIQUE,
  exchange_idempotency_key TEXT,
  exchange_request_digest CHAR(64) CHECK (
    exchange_request_digest IS NULL OR exchange_request_digest ~ '^[a-f0-9]{64}$'
  ),
  operator_session_ref UUID UNIQUE,
  session_expires_at TIMESTAMPTZ,
  delivery_envelope TEXT,
  exchange_receipt JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  recovery_expires_at TIMESTAMPTZ NOT NULL,
  delivery_expires_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(recovery_digest),
  UNIQUE(workload_identity_ref,environment,region,begin_idempotency_key),
  CHECK (expires_at > created_at AND recovery_expires_at >= expires_at),
  CHECK (
    (state='pending' AND exchange_command_id IS NULL AND operator_session_ref IS NULL)
    OR (state='redeeming' AND exchange_command_id IS NOT NULL AND claimed_at IS NOT NULL)
    OR (state='provider_outcome_unknown' AND exchange_command_id IS NOT NULL)
    OR (state='rejected' AND exchange_command_id IS NOT NULL)
    OR (state='committed' AND exchange_command_id IS NOT NULL AND operator_session_ref IS NOT NULL
        AND session_expires_at IS NOT NULL AND delivery_envelope IS NOT NULL
        AND exchange_receipt IS NOT NULL
        AND delivery_expires_at IS NOT NULL AND committed_at IS NOT NULL)
  )
);
CREATE INDEX admin_oidc_transaction_state_idx
  ON platform.admin_oidc_transaction(state,expires_at);

CREATE TABLE platform.admin_operator_session (
  operator_session_ref UUID PRIMARY KEY,
  credential_digest CHAR(64) NOT NULL CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK (operator_generation > 0),
  workload_identity_ref TEXT NOT NULL,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  managed_device_ref TEXT NOT NULL,
  audience TEXT NOT NULL,
  operator_security_epoch BIGINT NOT NULL CHECK (operator_security_epoch > 0),
  session_epoch BIGINT NOT NULL CHECK (session_epoch > 0),
  restriction_epoch BIGINT NOT NULL CHECK (restriction_epoch > 0),
  policy_epoch BIGINT NOT NULL CHECK (policy_epoch > 0),
  assurance_level TEXT NOT NULL CHECK (assurance_level IN ('password','mfa','phishing_resistant')),
  factor_classes TEXT[] NOT NULL CHECK (cardinality(factor_classes) BETWEEN 1 AND 16),
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  authenticated_at TIMESTAMPTZ NOT NULL,
  step_up_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_digest),
  FOREIGN KEY(operator_ref,operator_generation)
    REFERENCES platform.admin_operator_authority(operator_ref,operator_generation),
  CHECK (expires_at > created_at),
  CHECK ((state='revoked')=(revoked_at IS NOT NULL))
);
CREATE INDEX admin_operator_session_authority_idx
  ON platform.admin_operator_session(operator_ref,operator_generation,state,expires_at);
CREATE INDEX admin_operator_session_workload_idx
  ON platform.admin_operator_session(workload_identity_ref,environment,region,state,expires_at);

CREATE TABLE platform.admin_step_up_transaction (
  transaction_ref UUID PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','redeeming','committed','provider_outcome_unknown','rejected')),
  begin_command_id TEXT NOT NULL UNIQUE,
  begin_idempotency_key TEXT NOT NULL,
  begin_request_digest CHAR(64) NOT NULL CHECK(begin_request_digest ~ '^[a-f0-9]{64}$'),
  complete_command_id TEXT UNIQUE,
  complete_idempotency_key TEXT,
  complete_request_digest CHAR(64) CHECK(
    complete_request_digest IS NULL OR complete_request_digest ~ '^[a-f0-9]{64}$'
  ),
  operator_session_ref UUID NOT NULL REFERENCES platform.admin_operator_session(operator_session_ref),
  operator_ref TEXT NOT NULL,
  operator_generation BIGINT NOT NULL CHECK(operator_generation>0),
  requested_operation TEXT NOT NULL,
  resource_refs TEXT[] NOT NULL CHECK(cardinality(resource_refs) BETWEEN 1 AND 100),
  callback_ref TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  oidc_audience TEXT NOT NULL,
  exact_callback_uri TEXT NOT NULL,
  pkce_verifier_ciphertext TEXT NOT NULL,
  nonce_ciphertext TEXT NOT NULL,
  complete_receipt JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expires_at>created_at),
  CHECK((state='pending' AND complete_command_id IS NULL)
     OR (state IN ('redeeming','provider_outcome_unknown','rejected')
         AND complete_command_id IS NOT NULL AND claimed_at IS NOT NULL)
     OR (state='committed' AND complete_command_id IS NOT NULL AND complete_receipt IS NOT NULL
         AND completed_at IS NOT NULL))
);
CREATE INDEX admin_step_up_transaction_session_idx
  ON platform.admin_step_up_transaction(operator_session_ref,state,expires_at);

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
  required_permission TEXT NOT NULL,
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
     OR jsonb_typeof(p_authorities)<>'array'
     OR jsonb_array_length(p_authorities)<2 OR jsonb_array_length(p_authorities)>16 THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_authorities) AS item
    WHERE jsonb_typeof(item)<>'object'
       OR item-ARRAY['operatorRef','operatorGeneration','permissions','operatorSecurityEpoch',
                     'authorizationEpoch','expiresAt','siteScopes','globalScopes','identities']::TEXT[]<>'{}'::JSONB
       OR COALESCE(item->>'operatorRef','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
       OR COALESCE(item->>'operatorGeneration','') !~ '^[1-9][0-9]*$'
       OR COALESCE(item->>'operatorSecurityEpoch','') !~ '^[1-9][0-9]*$'
       OR COALESCE(item->>'authorizationEpoch','') !~ '^[1-9][0-9]*$'
       OR jsonb_typeof(item->'permissions')<>'array'
       OR jsonb_array_length(item->'permissions')<2
       OR NOT (item->'permissions' ?& ARRAY['admin.approval.execute','admin.authority.manage'])
       OR jsonb_typeof(item->'siteScopes')<>'array'
       OR jsonb_typeof(item->'globalScopes')<>'array'
       OR jsonb_array_length(item->'globalScopes')<1
       OR jsonb_typeof(item->'identities')<>'array'
       OR jsonb_array_length(item->'identities')<1
       OR NOT pg_input_is_valid(COALESCE(item->>'expiresAt',''),'timestamp with time zone')
       OR CASE
            WHEN pg_input_is_valid(COALESCE(item->>'expiresAt',''),'timestamp with time zone')
              THEN (item->>'expiresAt')::TIMESTAMPTZ<=now()
            ELSE TRUE
          END
  ) OR (
    SELECT count(*)<>count(DISTINCT item->>'operatorRef')
    FROM jsonb_array_elements(p_authorities) AS item
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'permissions') AS permission
    WHERE jsonb_typeof(permission)<>'string'
       OR length(permission #>> '{}')>128
       OR (permission #>> '{}') !~ '^[a-z][a-z0-9.-]*(\.\*)?$'
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_authorities) AS item
    WHERE jsonb_array_length(item->'permissions')<>(
      SELECT count(DISTINCT permission #>> '{}')
      FROM jsonb_array_elements(item->'permissions') AS permission
    )
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'siteScopes') AS scope
    WHERE jsonb_typeof(scope)<>'object'
       OR scope-ARRAY['siteRef','environment','region','scopeEpoch','expiresAt']::TEXT[]<>'{}'::JSONB
       OR COALESCE(scope->>'siteRef','')='*'
       OR COALESCE(scope->>'siteRef','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
       OR COALESCE(scope->>'environment','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
       OR COALESCE(scope->>'region','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
       OR COALESCE(scope->>'scopeEpoch','') !~ '^[1-9][0-9]*$'
       OR NOT pg_input_is_valid(COALESCE(scope->>'expiresAt',''),'timestamp with time zone')
       OR CASE
            WHEN pg_input_is_valid(COALESCE(scope->>'expiresAt',''),'timestamp with time zone')
              THEN (scope->>'expiresAt')::TIMESTAMPTZ<=now()
            ELSE TRUE
          END
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'globalScopes') AS scope
    WHERE jsonb_typeof(scope)<>'object'
       OR scope-ARRAY['grantRef','environment','region','scopeEpoch','expiresAt']::TEXT[]<>'{}'::JSONB
       OR COALESCE(scope->>'grantRef','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR COALESCE(scope->>'environment','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
       OR COALESCE(scope->>'region','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
       OR COALESCE(scope->>'scopeEpoch','') !~ '^[1-9][0-9]*$'
       OR NOT pg_input_is_valid(COALESCE(scope->>'expiresAt',''),'timestamp with time zone')
       OR CASE
            WHEN pg_input_is_valid(COALESCE(scope->>'expiresAt',''),'timestamp with time zone')
              THEN (scope->>'expiresAt')::TIMESTAMPTZ<=now()
            ELSE TRUE
          END
  ) OR (
    SELECT count(*)<>count(DISTINCT scope->>'grantRef')
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'globalScopes') AS scope
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'identities') AS identity
    WHERE jsonb_typeof(identity)<>'object'
       OR identity-ARRAY['identityRef','issuer','subject']::TEXT[]<>'{}'::JSONB
       OR COALESCE(identity->>'identityRef','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
       OR COALESCE(identity->>'issuer','') !~ '^https://'
       OR length(COALESCE(identity->>'issuer',''))>512
       OR length(COALESCE(identity->>'subject','')) NOT BETWEEN 1 AND 256
  ) OR (
    SELECT count(*)<>count(DISTINCT identity->>'identityRef')
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'identities') AS identity
  ) OR (
    SELECT count(*)<>count(DISTINCT jsonb_build_array(identity->>'issuer',identity->>'subject'))
    FROM jsonb_array_elements(p_authorities) AS item
    CROSS JOIN LATERAL jsonb_array_elements(item->'identities') AS identity
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
  INSERT INTO platform.admin_operator_authority(
    operator_ref,operator_generation,state,permissions,operator_security_epoch,
    authorization_epoch,expires_at
  )
  SELECT item->>'operatorRef',(item->>'operatorGeneration')::BIGINT,'active',
    ARRAY(SELECT jsonb_array_elements_text(item->'permissions')),
    (item->>'operatorSecurityEpoch')::BIGINT,(item->>'authorizationEpoch')::BIGINT,
    (item->>'expiresAt')::TIMESTAMPTZ
  FROM jsonb_array_elements(p_authorities) AS item;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;

  INSERT INTO platform.admin_operator_site_scope(
    operator_ref,operator_generation,site_ref,environment,region,scope_epoch,state,expires_at
  )
  SELECT item->>'operatorRef',(item->>'operatorGeneration')::BIGINT,scope->>'siteRef',
    scope->>'environment',scope->>'region',(scope->>'scopeEpoch')::BIGINT,'active',
    (scope->>'expiresAt')::TIMESTAMPTZ
  FROM jsonb_array_elements(p_authorities) AS item
  CROSS JOIN LATERAL jsonb_array_elements(item->'siteScopes') AS scope
  WHERE jsonb_typeof(scope)='object' AND scope->>'siteRef'<>'*'
    AND COALESCE(scope->>'siteRef','') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND COALESCE(scope->>'environment','') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
    AND COALESCE(scope->>'region','') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$'
    AND COALESCE(scope->>'scopeEpoch','') ~ '^[1-9][0-9]*$'
    AND COALESCE(scope->>'expiresAt','')::TIMESTAMPTZ>now();

  INSERT INTO platform.admin_operator_global_scope_grant(
    grant_ref,operator_ref,operator_generation,environment,region,scope_epoch,state,expires_at
  )
  SELECT (scope->>'grantRef')::UUID,item->>'operatorRef',
    (item->>'operatorGeneration')::BIGINT,scope->>'environment',scope->>'region',
    (scope->>'scopeEpoch')::BIGINT,'active',(scope->>'expiresAt')::TIMESTAMPTZ
  FROM jsonb_array_elements(p_authorities) AS item
  CROSS JOIN LATERAL jsonb_array_elements(item->'globalScopes') AS scope
  WHERE jsonb_typeof(scope)='object'
    AND COALESCE(scope->>'scopeEpoch','') ~ '^[1-9][0-9]*$'
    AND COALESCE(scope->>'expiresAt','')::TIMESTAMPTZ>now();

  INSERT INTO platform.admin_operator_identity(
    identity_ref,issuer,subject,operator_ref,operator_generation,state
  )
  SELECT (identity->>'identityRef')::UUID,identity->>'issuer',identity->>'subject',
    item->>'operatorRef',(item->>'operatorGeneration')::BIGINT,'active'
  FROM jsonb_array_elements(p_authorities) AS item
  CROSS JOIN LATERAL jsonb_array_elements(item->'identities') AS identity
  WHERE jsonb_typeof(identity)='object'
    AND left(COALESCE(identity->>'issuer',''),8)='https://'
    AND length(COALESCE(identity->>'subject','')) BETWEEN 1 AND 256;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_authorities) AS item
    WHERE (SELECT count(*) FROM platform.admin_operator_global_scope_grant grant_row
           WHERE grant_row.operator_ref=item->>'operatorRef'
             AND grant_row.operator_generation=(item->>'operatorGeneration')::BIGINT)=0
       OR (SELECT count(*) FROM platform.admin_operator_identity identity_row
           WHERE identity_row.operator_ref=item->>'operatorRef'
             AND identity_row.operator_generation=(item->>'operatorGeneration')::BIGINT)=0
  ) THEN
    RAISE EXCEPTION 'ADMIN_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;
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
  IF operator_name=approval_row.maker_ref OR operator_name=approval_row.checker_ref THEN
    RAISE EXCEPTION 'ADMIN_SELF_AUTHORITY_CHANGE_FORBIDDEN' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('app.admin_authority_function','true',true);

  IF action_name='provision' THEN
    IF p_change-ARRAY['action','operatorRef','operatorGeneration','permissions','siteScopes',
       'environments','regions','expiresAt']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(p_change->'permissions')<>'array'
       OR jsonb_array_length(p_change->'permissions')<1
       OR jsonb_typeof(p_change->'siteScopes')<>'array'
       OR jsonb_array_length(p_change->'siteScopes')<1
       OR jsonb_typeof(p_change->'environments')<>'array'
       OR jsonb_array_length(p_change->'environments')<1
       OR jsonb_typeof(p_change->'regions')<>'array'
       OR jsonb_array_length(p_change->'regions')<1
       OR p_change->'siteScopes' ? '*'
       OR COALESCE(p_change->>'expiresAt','')::TIMESTAMPTZ<=now() THEN
      RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.admin_operator_authority(
      operator_ref,operator_generation,state,permissions,operator_security_epoch,
      authorization_epoch,expires_at
    ) VALUES (
      operator_name,generation,'active',
      ARRAY(SELECT jsonb_array_elements_text(p_change->'permissions')),
      1,1,(p_change->>'expiresAt')::TIMESTAMPTZ
    );
    INSERT INTO platform.admin_operator_site_scope(
      operator_ref,operator_generation,site_ref,environment,region,scope_epoch,state,expires_at
    )
    SELECT operator_name,generation,site_ref,environment,region,1,'active',
      (p_change->>'expiresAt')::TIMESTAMPTZ
    FROM jsonb_array_elements_text(p_change->'siteScopes') AS sites(site_ref)
    CROSS JOIN jsonb_array_elements_text(p_change->'environments') AS environments(environment)
    CROSS JOIN jsonb_array_elements_text(p_change->'regions') AS regions(region);
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
         'permissions','siteScopes','environments','regions','expiresAt']::TEXT[]<>'{}'::JSONB
         OR jsonb_typeof(p_change->'permissions')<>'array'
         OR jsonb_array_length(p_change->'permissions')<1
         OR jsonb_typeof(p_change->'siteScopes')<>'array'
         OR jsonb_array_length(p_change->'siteScopes')<1
         OR jsonb_typeof(p_change->'environments')<>'array'
         OR jsonb_array_length(p_change->'environments')<1
         OR jsonb_typeof(p_change->'regions')<>'array'
         OR jsonb_array_length(p_change->'regions')<1
         OR p_change->'siteScopes' ? '*'
         OR COALESCE(p_change->>'expiresAt','')::TIMESTAMPTZ<=now() THEN
        RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
      END IF;
      UPDATE platform.admin_operator_authority SET state='active',
        permissions=ARRAY(SELECT jsonb_array_elements_text(p_change->'permissions')),
        operator_security_epoch=operator_security_epoch+1,
        authorization_epoch=next_epoch,expires_at=(p_change->>'expiresAt')::TIMESTAMPTZ,
        updated_at=now()
        WHERE operator_ref=operator_name AND operator_generation=generation;
      DELETE FROM platform.admin_operator_site_scope
        WHERE operator_ref=operator_name AND operator_generation=generation;
      INSERT INTO platform.admin_operator_site_scope(
        operator_ref,operator_generation,site_ref,environment,region,scope_epoch,state,expires_at
      )
      SELECT operator_name,generation,site_ref,environment,region,next_epoch,'active',
        (p_change->>'expiresAt')::TIMESTAMPTZ
      FROM jsonb_array_elements_text(p_change->'siteScopes') AS sites(site_ref)
      CROSS JOIN jsonb_array_elements_text(p_change->'environments') AS environments(environment)
      CROSS JOIN jsonb_array_elements_text(p_change->'regions') AS regions(region);
    ELSE
      IF p_change-ARRAY['action','operatorRef','operatorGeneration',
         'expectedAuthorizationEpoch']::TEXT[]<>'{}'::JSONB THEN
        RAISE EXCEPTION 'ADMIN_AUTHORITY_CHANGE_INVALID' USING ERRCODE='22023';
      END IF;
      UPDATE platform.admin_operator_authority
        SET state=CASE WHEN action_name='suspend' THEN 'suspended' ELSE 'revoked' END,
            operator_security_epoch=operator_security_epoch+1,
            authorization_epoch=next_epoch,updated_at=now()
        WHERE operator_ref=operator_name AND operator_generation=generation;
      UPDATE platform.admin_operator_site_scope SET state='revoked'
        WHERE operator_ref=operator_name AND operator_generation=generation AND state='active';
      UPDATE platform.admin_operator_global_scope_grant SET state='revoked'
        WHERE operator_ref=operator_name AND operator_generation=generation AND state='active';
      UPDATE platform.admin_breakglass_grant SET state='revoked'
        WHERE operator_ref=operator_name AND operator_generation=generation AND state='active';
      UPDATE platform.admin_operator_session SET state='revoked',revoked_at=now(),
        session_epoch=session_epoch+1,updated_at=now()
        WHERE operator_ref=operator_name AND operator_generation=generation AND state='active';
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
  IF ROW(OLD.review_ref,OLD.command_id,OLD.request_digest,OLD.operation,OLD.required_permission,OLD.maker_ref,
         OLD.maker_generation,OLD.maker_authorization_epoch,OLD.target_site_ref,
         OLD.environment,OLD.region,OLD.break_glass_ticket_ref,OLD.outcome,
         OLD.outcome_digest,OLD.created_at,OLD.expires_at)
     IS DISTINCT FROM
     ROW(NEW.review_ref,NEW.command_id,NEW.request_digest,NEW.operation,NEW.required_permission,NEW.maker_ref,
         NEW.maker_generation,NEW.maker_authorization_epoch,NEW.target_site_ref,
         NEW.environment,NEW.region,NEW.break_glass_ticket_ref,NEW.outcome,
         NEW.outcome_digest,NEW.created_at,NEW.expires_at) THEN
    RAISE EXCEPTION 'ADMIN_POST_EFFECT_REVIEW_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_admin_oidc_transaction_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.transaction_ref,OLD.begin_command_id,OLD.begin_idempotency_key,
         OLD.begin_request_digest,OLD.workload_identity_ref,OLD.environment,OLD.region,
         OLD.managed_device_ref,OLD.audience,OLD.return_intent_ref,OLD.issuer,OLD.client_id,
         OLD.oidc_audience,OLD.exact_callback_uri,OLD.pkce_verifier_ciphertext,OLD.pkce_challenge,
         OLD.nonce_ciphertext,OLD.state_digest,OLD.recovery_digest,OLD.signing_key_revision,
         OLD.delivery_key_revision,OLD.expires_at,OLD.recovery_expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.transaction_ref,NEW.begin_command_id,NEW.begin_idempotency_key,
         NEW.begin_request_digest,NEW.workload_identity_ref,NEW.environment,NEW.region,
         NEW.managed_device_ref,NEW.audience,NEW.return_intent_ref,NEW.issuer,NEW.client_id,
         NEW.oidc_audience,NEW.exact_callback_uri,NEW.pkce_verifier_ciphertext,NEW.pkce_challenge,
         NEW.nonce_ciphertext,NEW.state_digest,NEW.recovery_digest,NEW.signing_key_revision,
         NEW.delivery_key_revision,NEW.expires_at,NEW.recovery_expires_at,NEW.created_at) THEN
    RAISE EXCEPTION 'ADMIN_OIDC_TRANSACTION_FROZEN_FACT_MUTATION' USING ERRCODE='23000';
  END IF;
  IF NOT ((OLD.state='pending' AND NEW.state='redeeming')
       OR (OLD.state='redeeming' AND NEW.state IN ('committed','provider_outcome_unknown','rejected')))
     OR (OLD.state<>'pending' AND ROW(OLD.exchange_command_id,OLD.exchange_idempotency_key,
         OLD.exchange_request_digest,OLD.claimed_at) IS DISTINCT FROM
         ROW(NEW.exchange_command_id,NEW.exchange_idempotency_key,
         NEW.exchange_request_digest,NEW.claimed_at)) THEN
    RAISE EXCEPTION 'ADMIN_OIDC_TRANSACTION_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_admin_operator_session_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.operator_session_ref,OLD.credential_digest,OLD.operator_ref,
         OLD.operator_generation,OLD.workload_identity_ref,OLD.environment,OLD.region,
         OLD.managed_device_ref,OLD.audience,OLD.operator_security_epoch,
         OLD.restriction_epoch,OLD.policy_epoch,OLD.authenticated_at,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.operator_session_ref,NEW.credential_digest,NEW.operator_ref,
         NEW.operator_generation,NEW.workload_identity_ref,NEW.environment,NEW.region,
         NEW.managed_device_ref,NEW.audience,NEW.operator_security_epoch,
         NEW.restriction_epoch,NEW.policy_epoch,NEW.authenticated_at,NEW.expires_at,NEW.created_at)
     OR OLD.state<>'active' OR NEW.session_epoch<>OLD.session_epoch+1
     OR NOT (
       (NEW.state IN ('revoked','expired') AND NEW.assurance_level=OLD.assurance_level
        AND NEW.factor_classes=OLD.factor_classes AND NEW.step_up_at IS NOT DISTINCT FROM OLD.step_up_at)
       OR (NEW.state='active' AND NEW.assurance_level='phishing_resistant'
           AND NEW.step_up_at IS NOT NULL AND NEW.step_up_at>COALESCE(OLD.step_up_at,OLD.authenticated_at))
     ) THEN
    RAISE EXCEPTION 'ADMIN_OPERATOR_SESSION_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION platform.guard_admin_step_up_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.transaction_ref,OLD.begin_command_id,OLD.begin_idempotency_key,
         OLD.begin_request_digest,OLD.operator_session_ref,OLD.operator_ref,
         OLD.operator_generation,OLD.requested_operation,OLD.resource_refs,OLD.callback_ref,
         OLD.issuer,OLD.client_id,OLD.oidc_audience,OLD.exact_callback_uri,
         OLD.pkce_verifier_ciphertext,OLD.nonce_ciphertext,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.transaction_ref,NEW.begin_command_id,NEW.begin_idempotency_key,
         NEW.begin_request_digest,NEW.operator_session_ref,NEW.operator_ref,
         NEW.operator_generation,NEW.requested_operation,NEW.resource_refs,NEW.callback_ref,
         NEW.issuer,NEW.client_id,NEW.oidc_audience,NEW.exact_callback_uri,
         NEW.pkce_verifier_ciphertext,NEW.nonce_ciphertext,NEW.expires_at,NEW.created_at)
     OR NOT ((OLD.state='pending' AND NEW.state='redeeming')
          OR (OLD.state='redeeming' AND NEW.state IN ('committed','provider_outcome_unknown','rejected'))) THEN
    RAISE EXCEPTION 'ADMIN_STEP_UP_TRANSITION_INVALID' USING ERRCODE='23514';
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
CREATE TRIGGER admin_oidc_transaction_transition_guard
  BEFORE UPDATE ON platform.admin_oidc_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.guard_admin_oidc_transaction_transition();
CREATE TRIGGER admin_oidc_transaction_no_delete
  BEFORE DELETE ON platform.admin_oidc_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();
CREATE TRIGGER admin_operator_session_transition_guard
  BEFORE UPDATE ON platform.admin_operator_session
  FOR EACH ROW EXECUTE FUNCTION platform.guard_admin_operator_session_transition();
CREATE TRIGGER admin_operator_session_no_delete
  BEFORE DELETE ON platform.admin_operator_session
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();
CREATE TRIGGER admin_step_up_transaction_transition_guard
  BEFORE UPDATE ON platform.admin_step_up_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.guard_admin_step_up_transition();
CREATE TRIGGER admin_step_up_transaction_no_delete
  BEFORE DELETE ON platform.admin_step_up_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_admin_immutable_mutation();

ALTER TABLE platform.admin_operator_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_site_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_site_scope FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_global_scope_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_global_scope_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_breakglass_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_breakglass_grant FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_identity FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_oidc_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_oidc_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_operator_session FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_step_up_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admin_step_up_transaction FORCE ROW LEVEL SECURITY;
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

CREATE POLICY admin_typed_authority_bootstrap
  ON platform.admin_operator_site_scope FOR INSERT
  WITH CHECK (current_setting('app.admin_bootstrap',true)='true');
CREATE POLICY admin_global_authority_bootstrap
  ON platform.admin_operator_global_scope_grant FOR INSERT
  WITH CHECK (current_setting('app.admin_bootstrap',true)='true');
CREATE POLICY admin_identity_bootstrap
  ON platform.admin_operator_identity FOR INSERT
  WITH CHECK (current_setting('app.admin_bootstrap',true)='true');
CREATE POLICY admin_identity_oidc_resolution
  ON platform.admin_operator_identity FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.identity.exchange'
  );
CREATE POLICY admin_authority_oidc_resolution
  ON platform.admin_operator_authority FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.identity.exchange'
  );
CREATE POLICY admin_typed_authority_governed_change
  ON platform.admin_operator_site_scope FOR ALL
  USING (current_setting('app.admin_authority_function',true)='true')
  WITH CHECK (current_setting('app.admin_authority_function',true)='true');
CREATE POLICY admin_global_authority_governed_change
  ON platform.admin_operator_global_scope_grant FOR ALL
  USING (current_setting('app.admin_authority_function',true)='true')
  WITH CHECK (current_setting('app.admin_authority_function',true)='true');
CREATE POLICY admin_breakglass_authority_governed_change
  ON platform.admin_breakglass_grant FOR ALL
  USING (current_setting('app.admin_authority_function',true)='true')
  WITH CHECK (current_setting('app.admin_authority_function',true)='true');
CREATE POLICY admin_session_governed_revocation
  ON platform.admin_operator_session FOR UPDATE
  USING (current_setting('app.admin_authority_function',true)='true')
  WITH CHECK (current_setting('app.admin_authority_function',true)='true');

CREATE POLICY admin_oidc_workload_fence
  ON platform.admin_oidc_transaction
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true) IN (
      'admin.identity.begin','admin.identity.exchange','admin.identity.delivery.read'
    )
    AND workload_identity_ref=current_setting('app.workload_identity_ref',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND managed_device_ref=current_setting('app.managed_device_ref',true)
    AND audience=current_setting('app.audience',true)
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true) IN ('admin.identity.begin','admin.identity.exchange')
    AND workload_identity_ref=current_setting('app.workload_identity_ref',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND managed_device_ref=current_setting('app.managed_device_ref',true)
    AND audience=current_setting('app.audience',true)
  );
CREATE POLICY admin_session_identity_issue
  ON platform.admin_operator_session FOR INSERT
  WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.identity.exchange'
    AND workload_identity_ref=current_setting('app.workload_identity_ref',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND managed_device_ref=current_setting('app.managed_device_ref',true)
    AND audience=current_setting('app.audience',true)
  );
CREATE POLICY admin_session_authenticate
  ON platform.admin_operator_session FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.session.authenticate'
    AND workload_identity_ref=current_setting('app.workload_identity_ref',true)
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND managed_device_ref=current_setting('app.managed_device_ref',true)
    AND audience=current_setting('app.audience',true)
  );
CREATE POLICY admin_step_up_owner_scope
  ON platform.admin_step_up_transaction
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND current_setting('app.operation',true) IN (
      'admin.identity.step-up.begin','admin.identity.step-up.complete'
    )
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND current_setting('app.operation',true) IN (
      'admin.identity.step-up.begin','admin.identity.step-up.complete'
    )
  );
CREATE POLICY admin_session_operator_mutation
  ON platform.admin_operator_session FOR UPDATE
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND current_setting('app.operation',true) IN (
      'admin.identity.step-up.complete','admin.identity.sign-out'
    )
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_session_operator_read
  ON platform.admin_operator_session FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND current_setting('app.operation',true) IN (
      'admin.identity.step-up.begin','admin.identity.step-up.complete','admin.identity.sign-out'
    )
  );
CREATE POLICY admin_identity_step_up_read
  ON platform.admin_operator_identity FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
    AND current_setting('app.operation',true)='admin.identity.step-up.complete'
  );
CREATE POLICY admin_operator_authority_authenticated_read
  ON platform.admin_operator_authority FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.session.authenticate'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_site_scope_authenticated_read
  ON platform.admin_operator_site_scope FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.session.authenticate'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_global_scope_authenticated_read
  ON platform.admin_operator_global_scope_grant FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.session.authenticate'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_breakglass_scope_authenticated_read
  ON platform.admin_breakglass_grant FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.operation',true)='admin.session.authenticate'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_site_scope_control_plane_read
  ON platform.admin_operator_site_scope FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_global_scope_control_plane_read
  ON platform.admin_operator_global_scope_grant FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
  );
CREATE POLICY admin_breakglass_scope_control_plane_read
  ON platform.admin_breakglass_grant FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND operator_ref=current_setting('app.subject_id',true)
  );

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
CREATE POLICY admin_command_decision_scoped_read
  ON platform.admin_command_decision FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.actor_kind',true)='operator'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR (current_setting('app.admin_scope_kind',true)='site'
          AND current_setting('app.admin_site_refs',true)::JSONB ? COALESCE(target_site_ref,''))
      OR (current_setting('app.admin_scope_kind',true)='breakglass'
          AND current_setting('app.admin_site_refs',true)::JSONB ? decision_ref::TEXT)
    )
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
    (state IN ('expired','stale_authority','effect_rejected')
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
  platform.admin_operator_site_scope,
  platform.admin_operator_global_scope_grant,
  platform.admin_breakglass_grant,
  platform.admin_operator_identity,
  platform.admin_oidc_transaction,
  platform.admin_operator_session,
  platform.admin_step_up_transaction,
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
REVOKE ALL ON FUNCTION platform.guard_admin_oidc_transaction_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_admin_operator_session_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_admin_step_up_transition() FROM PUBLIC;
