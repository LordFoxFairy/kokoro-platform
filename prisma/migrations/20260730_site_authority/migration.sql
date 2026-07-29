SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.site (
  site_ref TEXT PRIMARY KEY,
  site_key TEXT NOT NULL UNIQUE CHECK(site_key ~ '^[a-z][a-z0-9-]{2,62}$'),
  state TEXT NOT NULL CHECK(state IN ('preview_ready','active','suspended','decommissioning','decommissioned')),
  active_release_ref TEXT,
  security_epoch BIGINT NOT NULL DEFAULT 1 CHECK(security_epoch > 0),
  policy_epoch BIGINT NOT NULL DEFAULT 1 CHECK(policy_epoch > 0),
  revocation_epoch BIGINT NOT NULL DEFAULT 1 CHECK(revocation_epoch > 0),
  tombstoned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(state<>'active' OR active_release_ref IS NOT NULL),
  CHECK(state NOT IN ('preview_ready','decommissioning','decommissioned') OR active_release_ref IS NULL),
  CHECK((state='decommissioned')=(tombstoned_at IS NOT NULL))
);
CREATE INDEX site_state_idx ON platform.site(state);

CREATE TABLE platform.site_project_binding (
  binding_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  repository_ref TEXT NOT NULL UNIQUE,
  provider_project_ref TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','production')),
  workload_identity_id TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL DEFAULT 1 CHECK(binding_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(binding_ref,site_ref),
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
  environment TEXT NOT NULL CHECK(environment IN ('development','preview','production')),
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
  state TEXT NOT NULL CHECK(state IN ('preparing','promote_requested','observing','pointer_committing','draining','succeeded','failed','unknown')),
  requested_at TIMESTAMPTZ NOT NULL,
  provider_operation_key TEXT UNIQUE,
  deployment_ref TEXT,
  observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(candidate_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref),
  FOREIGN KEY(expected_active_release_ref,site_ref) REFERENCES platform.site_release(release_ref,site_ref),
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
     NEW.revocation_epoch < OLD.revocation_epoch THEN
    RAISE EXCEPTION 'Site epochs cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_decommissioned_terminal() FROM PUBLIC;
CREATE TRIGGER site_decommissioned_terminal
BEFORE UPDATE ON platform.site FOR EACH ROW
EXECUTE FUNCTION platform.site_decommissioned_terminal();

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

REVOKE ALL ON
  platform.site,
  platform.site_project_binding,
  platform.site_release,
  platform.site_deployment_binding,
  platform.site_activation_attempt,
  platform.site_deployment_observation
FROM PUBLIC;
