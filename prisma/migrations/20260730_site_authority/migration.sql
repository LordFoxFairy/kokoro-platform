SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.site (
  site_ref TEXT PRIMARY KEY,
  site_key TEXT NOT NULL UNIQUE CHECK(site_key ~ '^[a-z][a-z0-9-]{2,62}$'),
  state TEXT NOT NULL CHECK(state IN ('preview_ready','active','suspending','suspended','decommissioning','decommissioned')),
  active_release_ref TEXT,
  security_epoch BIGINT NOT NULL DEFAULT 1 CHECK(security_epoch > 0),
  policy_epoch BIGINT NOT NULL DEFAULT 1 CHECK(policy_epoch > 0),
  revocation_epoch BIGINT NOT NULL DEFAULT 1 CHECK(revocation_epoch > 0),
  runtime_binding_epoch BIGINT NOT NULL DEFAULT 1 CHECK(runtime_binding_epoch > 0),
  tombstoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(state NOT IN ('active','suspending') OR active_release_ref IS NOT NULL),
  CHECK(state NOT IN ('preview_ready','decommissioned') OR active_release_ref IS NULL),
  CHECK((state='decommissioned')=(tombstoned_at IS NOT NULL))
);
CREATE INDEX site_state_idx ON platform.site(state);

CREATE TABLE platform.site_project_binding (
  binding_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  repository_ref TEXT NOT NULL UNIQUE,
  provider_namespace TEXT NOT NULL CHECK(provider_namespace ~ '^[a-z][a-z0-9.-]{1,63}$'),
  provider_project_ref TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','staging','production')),
  region TEXT NOT NULL,
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL DEFAULT 1 CHECK(binding_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(binding_ref,site_ref),
  UNIQUE(provider_namespace,provider_project_ref,environment),
  UNIQUE(workload_identity_id)
);
CREATE UNIQUE INDEX site_one_active_project_environment_idx
  ON platform.site_project_binding(site_ref,environment) WHERE state='active';

CREATE TABLE platform.site_release (
  release_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  state TEXT NOT NULL CHECK(state IN ('ready','active','draining','retired')),
  web_artifact_digest CHAR(64) NOT NULL CHECK(web_artifact_digest ~ '^[0-9a-f]{64}$'),
  release_manifest_digest CHAR(64) NOT NULL CHECK(release_manifest_digest ~ '^[0-9a-f]{64}$'),
  certification_digest CHAR(64) NOT NULL CHECK(certification_digest ~ '^[0-9a-f]{64}$'),
  launch_profile_ref TEXT NOT NULL,
  site_config_revision_ref TEXT NOT NULL,
  legal_revision_ref TEXT NOT NULL,
  feature_policy_revision TEXT NOT NULL,
  model_option_catalog_ref TEXT NOT NULL,
  agent_catalog_ref TEXT NOT NULL,
  identity_issuer_label TEXT NOT NULL,
  identity_auth_strength_policy_revision TEXT NOT NULL,
  enabled_surface_ids JSONB NOT NULL CHECK(jsonb_typeof(enabled_surface_ids)='array'),
  locale_policy JSONB NOT NULL CHECK(jsonb_typeof(locale_policy)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(release_ref,site_ref)
);
CREATE INDEX site_release_site_state_idx ON platform.site_release(site_ref,state);
ALTER TABLE platform.site ADD CONSTRAINT site_active_release_owner_fk
  FOREIGN KEY(active_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE platform.site_deployment_binding (
  deployment_ref TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  release_ref TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','staging','production')),
  region TEXT NOT NULL,
  audience TEXT NOT NULL,
  session_contract_revision TEXT NOT NULL,
  web_artifact_digest CHAR(64) NOT NULL CHECK(web_artifact_digest ~ '^[0-9a-f]{64}$'),
  binding_epoch BIGINT NOT NULL DEFAULT 1 CHECK(binding_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('candidate','active','draining','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(deployment_ref),
  UNIQUE(deployment_ref,site_ref,release_ref),
  FOREIGN KEY(binding_ref,site_ref) REFERENCES platform.site_project_binding(binding_ref,site_ref),
  FOREIGN KEY(release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref)
);
CREATE UNIQUE INDEX site_one_active_deployment_environment_idx
  ON platform.site_deployment_binding(site_ref,environment) WHERE state='active';
CREATE INDEX site_deployment_release_idx ON platform.site_deployment_binding(site_ref,release_ref,state);

CREATE TABLE platform.site_activation_attempt (
  attempt_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  candidate_release_ref TEXT NOT NULL,
  expected_active_release_ref TEXT,
  candidate_web_artifact_digest CHAR(64) NOT NULL CHECK(candidate_web_artifact_digest ~ '^[0-9a-f]{64}$'),
  candidate_manifest_digest CHAR(64) NOT NULL CHECK(candidate_manifest_digest ~ '^[0-9a-f]{64}$'),
  candidate_certification_digest CHAR(64) NOT NULL CHECK(candidate_certification_digest ~ '^[0-9a-f]{64}$'),
  site_project_binding_ref TEXT NOT NULL,
  site_project_binding_epoch BIGINT NOT NULL CHECK(site_project_binding_epoch > 0),
  runtime_binding_epoch BIGINT NOT NULL CHECK(runtime_binding_epoch > 0),
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','staging','production')),
  region TEXT NOT NULL,
  audience TEXT NOT NULL,
  session_contract_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','promote_requested','observing','pointer_committing','draining','succeeded','failed','unknown')),
  requested_at TIMESTAMPTZ NOT NULL,
  provider_operation_key TEXT UNIQUE,
  deployment_ref TEXT,
  observed_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(candidate_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref),
  FOREIGN KEY(expected_active_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref),
  FOREIGN KEY(site_project_binding_ref,site_ref) REFERENCES platform.site_project_binding(binding_ref,site_ref),
  FOREIGN KEY(deployment_ref,site_ref,candidate_release_ref)
    REFERENCES platform.site_deployment_binding(deployment_ref,site_ref,release_ref),
  UNIQUE(site_ref,runtime_binding_epoch),
  CHECK((state='preparing') OR provider_operation_key IS NOT NULL),
  CHECK((state NOT IN ('pointer_committing','draining','succeeded')) OR
        (deployment_ref IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE INDEX site_activation_reconcile_idx
  ON platform.site_activation_attempt(state,updated_at,site_ref);

CREATE TABLE platform.site_deployment_observation (
  observation_ref UUID PRIMARY KEY,
  attempt_ref TEXT NOT NULL REFERENCES platform.site_activation_attempt(attempt_ref),
  provider_operation_key TEXT NOT NULL,
  deployment_ref TEXT NOT NULL,
  release_ref TEXT NOT NULL,
  web_artifact_digest CHAR(64) NOT NULL CHECK(web_artifact_digest ~ '^[0-9a-f]{64}$'),
  healthy BOOLEAN NOT NULL,
  traffic_ready BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(attempt_ref,payload_digest)
);
CREATE INDEX site_deployment_observation_attempt_idx
  ON platform.site_deployment_observation(attempt_ref,observed_at);

CREATE TABLE platform.site_traffic_stop_attempt (
  attempt_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  action TEXT NOT NULL CHECK(action IN ('suspend','decommission')),
  release_ref TEXT NOT NULL,
  deployment_ref TEXT NOT NULL,
  binding_ref TEXT NOT NULL,
  runtime_binding_epoch BIGINT NOT NULL CHECK(runtime_binding_epoch > 0),
  provider_namespace TEXT NOT NULL CHECK(provider_namespace ~ '^[a-z][a-z0-9.-]{1,63}$'),
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','staging','production')),
  region TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','stop_requested','observing','succeeded','failed','unknown')),
  requested_at TIMESTAMPTZ NOT NULL,
  provider_operation_key TEXT UNIQUE,
  observed_at TIMESTAMPTZ,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(deployment_ref,site_ref,release_ref)
    REFERENCES platform.site_deployment_binding(deployment_ref,site_ref,release_ref),
  FOREIGN KEY(binding_ref,site_ref) REFERENCES platform.site_project_binding(binding_ref,site_ref),
  CHECK((state='requested')=(provider_operation_key IS NULL))
);
CREATE UNIQUE INDEX site_one_open_traffic_stop_idx ON platform.site_traffic_stop_attempt(site_ref)
  WHERE state IN ('requested','stop_requested','observing','failed','unknown');
CREATE INDEX site_traffic_stop_reconcile_idx
  ON platform.site_traffic_stop_attempt(state,updated_at,site_ref);

CREATE TABLE platform.site_traffic_stop_observation (
  observation_ref UUID PRIMARY KEY,
  attempt_ref TEXT NOT NULL REFERENCES platform.site_traffic_stop_attempt(attempt_ref),
  provider_operation_key TEXT NOT NULL,
  deployment_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('serving','stopped','unknown')),
  observed_at TIMESTAMPTZ NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(attempt_ref,payload_digest)
);

CREATE TABLE platform.site_effect_approval (
  approval_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  operation TEXT NOT NULL CHECK(operation IN (
    'site.activation.begin',
    'site.traffic-stop.suspend',
    'site.traffic-stop.decommission'
  )),
  effect_digest CHAR(64) NOT NULL CHECK(effect_digest ~ '^[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 512),
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('pending','approved','consumed','revoked')),
  maker_subject_ref TEXT NOT NULL,
  checker_subject_ref TEXT,
  requested_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_request_id TEXT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(expires_at>requested_at),
  CHECK(maker_subject_ref<>checker_subject_ref),
  CHECK(state NOT IN ('approved','consumed') OR checker_subject_ref IS NOT NULL),
  CHECK(state<>'pending' OR checker_subject_ref IS NULL),
  CHECK(state NOT IN ('approved','consumed') OR decided_at IS NOT NULL),
  CHECK(state<>'pending' OR decided_at IS NULL),
  CHECK((state='consumed')=(consumed_at IS NOT NULL)),
  CHECK(state<>'consumed' OR consumed_request_id IS NOT NULL)
);
CREATE INDEX site_effect_approval_lookup_idx
  ON platform.site_effect_approval(site_ref,operation,effect_digest,state,expires_at);

CREATE FUNCTION platform.site_release_immutable_facts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.release_ref,NEW.site_ref,NEW.web_artifact_digest,NEW.release_manifest_digest,
         NEW.certification_digest,NEW.launch_profile_ref,NEW.site_config_revision_ref,
         NEW.legal_revision_ref,NEW.feature_policy_revision,NEW.model_option_catalog_ref,
         NEW.agent_catalog_ref,NEW.identity_issuer_label,
         NEW.identity_auth_strength_policy_revision,NEW.enabled_surface_ids,NEW.locale_policy,
         NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.release_ref,OLD.site_ref,OLD.web_artifact_digest,OLD.release_manifest_digest,
         OLD.certification_digest,OLD.launch_profile_ref,OLD.site_config_revision_ref,
         OLD.legal_revision_ref,OLD.feature_policy_revision,OLD.model_option_catalog_ref,
         OLD.agent_catalog_ref,OLD.identity_issuer_label,
         OLD.identity_auth_strength_policy_revision,OLD.enabled_surface_ids,OLD.locale_policy,
         OLD.created_at) THEN
    RAISE EXCEPTION 'site release immutable facts cannot change';
  END IF;
  IF NOT ((OLD.state='ready' AND NEW.state IN ('ready','active','retired')) OR
          (OLD.state='active' AND NEW.state IN ('active','draining')) OR
          (OLD.state='draining' AND NEW.state IN ('draining','retired')) OR
          (OLD.state='retired' AND NEW.state='retired')) THEN
    RAISE EXCEPTION 'site release state transition invalid';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_release_immutable_facts() FROM PUBLIC;
CREATE TRIGGER site_release_immutable_facts
BEFORE UPDATE ON platform.site_release FOR EACH ROW
EXECUTE FUNCTION platform.site_release_immutable_facts();

CREATE FUNCTION platform.site_decommissioned_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='decommissioned' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'decommissioned Site is terminal';
  END IF;
  IF NEW.security_epoch < OLD.security_epoch OR NEW.policy_epoch < OLD.policy_epoch OR
     NEW.revocation_epoch < OLD.revocation_epoch OR
     NEW.runtime_binding_epoch < OLD.runtime_binding_epoch THEN
    RAISE EXCEPTION 'Site epochs cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_decommissioned_terminal() FROM PUBLIC;
CREATE TRIGGER site_decommissioned_terminal
BEFORE UPDATE ON platform.site FOR EACH ROW
EXECUTE FUNCTION platform.site_decommissioned_terminal();

CREATE FUNCTION platform.site_runtime_binding_epoch_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.site owner
    WHERE owner.site_ref=NEW.site_ref
      AND owner.runtime_binding_epoch>=NEW.runtime_binding_epoch
  ) THEN
    RAISE EXCEPTION 'Site runtime binding epoch is not owner-reserved';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_runtime_binding_epoch_guard() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER site_runtime_binding_epoch_monotonic
AFTER INSERT OR UPDATE ON platform.site_activation_attempt
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION platform.site_runtime_binding_epoch_guard();

CREATE FUNCTION platform.reject_site_deployment_observation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Site deployment observations are immutable';
END;
$$;
REVOKE ALL ON FUNCTION platform.reject_site_deployment_observation_update() FROM PUBLIC;
CREATE TRIGGER site_deployment_observation_immutable
BEFORE UPDATE OR DELETE ON platform.site_deployment_observation FOR EACH ROW
EXECUTE FUNCTION platform.reject_site_deployment_observation_update();

CREATE TRIGGER site_traffic_stop_observation_immutable
BEFORE UPDATE OR DELETE ON platform.site_traffic_stop_observation FOR EACH ROW
EXECUTE FUNCTION platform.reject_site_deployment_observation_update();

CREATE FUNCTION platform.site_effect_approval_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.approval_ref,NEW.site_ref,NEW.operation,NEW.effect_digest,NEW.reason,
         NEW.command_id,NEW.idempotency_key,NEW.request_digest,
         NEW.maker_subject_ref,NEW.requested_at,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.approval_ref,OLD.site_ref,OLD.operation,OLD.effect_digest,OLD.reason,
         OLD.command_id,OLD.idempotency_key,OLD.request_digest,
         OLD.maker_subject_ref,OLD.requested_at,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'Site effect approval immutable facts cannot change';
  END IF;
  IF NOT ((OLD.state='pending' AND NEW.state IN ('pending','approved','revoked')) OR
          (OLD.state='approved' AND NEW.state IN ('approved','consumed','revoked')) OR
          (OLD.state='consumed' AND NEW IS NOT DISTINCT FROM OLD) OR
          (OLD.state='revoked' AND NEW IS NOT DISTINCT FROM OLD)) THEN
    RAISE EXCEPTION 'Site effect approval transition invalid';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_effect_approval_terminal() FROM PUBLIC;
CREATE TRIGGER site_effect_approval_terminal
BEFORE UPDATE ON platform.site_effect_approval FOR EACH ROW
EXECUTE FUNCTION platform.site_effect_approval_terminal();

-- Site authority is scoped by the verified transaction context. The worker is a
-- separately credentialed reconciler and must locate claimed attempts before it
-- can establish a row-specific Site context; its table/column grants remain the
-- second, least-privilege boundary.
ALTER TABLE platform.site ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site FORCE ROW LEVEL SECURITY;
CREATE POLICY site_scope ON platform.site
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');
CREATE POLICY site_admin_read_scope ON platform.site FOR SELECT USING(
  current_setting('app.workload_kind',true)='platform_admin'
  AND current_setting('app.actor_kind',true)='operator'
  AND (
    current_setting('app.admin_scope_kind',true)='global'
    OR current_setting('app.admin_site_refs',true)::JSONB ? site_ref
  )
);

ALTER TABLE platform.site_project_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_project_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY site_project_binding_scope ON platform.site_project_binding
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');

ALTER TABLE platform.site_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release FORCE ROW LEVEL SECURITY;
CREATE POLICY site_release_scope ON platform.site_release
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');

ALTER TABLE platform.site_deployment_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_deployment_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY site_deployment_binding_scope ON platform.site_deployment_binding
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');
CREATE POLICY site_deployment_binding_admin_read_scope
  ON platform.site_deployment_binding FOR SELECT USING(
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.actor_kind',true)='operator'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR current_setting('app.admin_site_refs',true)::JSONB ? site_ref
    )
  );

ALTER TABLE platform.site_activation_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_activation_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY site_activation_attempt_scope ON platform.site_activation_attempt
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');

ALTER TABLE platform.site_traffic_stop_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_traffic_stop_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY site_traffic_stop_attempt_scope ON platform.site_traffic_stop_attempt
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');

ALTER TABLE platform.site_effect_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_effect_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY site_effect_approval_scope ON platform.site_effect_approval
  USING(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker')
  WITH CHECK(site_ref=NULLIF(current_setting('app.site_id',true),'') OR current_setting('app.workload_kind',true)='platform_worker');

ALTER TABLE platform.site_deployment_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_deployment_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY site_deployment_observation_scope ON platform.site_deployment_observation
  USING(current_setting('app.workload_kind',true)='platform_worker' OR EXISTS (
    SELECT 1 FROM platform.site_activation_attempt attempt
    WHERE attempt.attempt_ref=site_deployment_observation.attempt_ref
      AND attempt.site_ref=NULLIF(current_setting('app.site_id',true),'')
  ))
  WITH CHECK(current_setting('app.workload_kind',true)='platform_worker' OR EXISTS (
    SELECT 1 FROM platform.site_activation_attempt attempt
    WHERE attempt.attempt_ref=site_deployment_observation.attempt_ref
      AND attempt.site_ref=NULLIF(current_setting('app.site_id',true),'')
  ));

ALTER TABLE platform.site_traffic_stop_observation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_traffic_stop_observation FORCE ROW LEVEL SECURITY;
CREATE POLICY site_traffic_stop_observation_scope ON platform.site_traffic_stop_observation
  USING(current_setting('app.workload_kind',true)='platform_worker' OR EXISTS (
    SELECT 1 FROM platform.site_traffic_stop_attempt attempt
    WHERE attempt.attempt_ref=site_traffic_stop_observation.attempt_ref
      AND attempt.site_ref=NULLIF(current_setting('app.site_id',true),'')
  ))
  WITH CHECK(current_setting('app.workload_kind',true)='platform_worker' OR EXISTS (
    SELECT 1 FROM platform.site_traffic_stop_attempt attempt
    WHERE attempt.attempt_ref=site_traffic_stop_observation.attempt_ref
      AND attempt.site_ref=NULLIF(current_setting('app.site_id',true),'')
  ));

REVOKE ALL ON
  platform.site,
  platform.site_project_binding,
  platform.site_release,
  platform.site_deployment_binding,
  platform.site_activation_attempt,
  platform.site_deployment_observation,
  platform.site_traffic_stop_attempt,
  platform.site_traffic_stop_observation,
  platform.site_effect_approval
FROM PUBLIC;
