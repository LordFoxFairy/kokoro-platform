SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.authorization_site (
  site_ref TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active','suspended','decommissioning')),
  security_epoch BIGINT NOT NULL CHECK (security_epoch > 0),
  policy_epoch BIGINT NOT NULL CHECK (policy_epoch > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE platform.authorization_site_release (
  release_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  state TEXT NOT NULL CHECK (state IN ('active','retired','revoked')),
  web_artifact_digest CHAR(64) NOT NULL CHECK (web_artifact_digest ~ '^[a-f0-9]{64}$'),
  enabled_surface_ids JSONB NOT NULL CHECK (jsonb_typeof(enabled_surface_ids)='array'),
  feature_policy_revision TEXT NOT NULL,
  model_option_catalog_ref TEXT NOT NULL,
  agent_catalog_ref TEXT NOT NULL,
  identity_issuer_label TEXT NOT NULL CHECK (
    identity_issuer_label=btrim(identity_issuer_label)
    AND length(identity_issuer_label) BETWEEN 1 AND 64
    AND identity_issuer_label !~ '[[:cntrl:]]'
  ),
  identity_auth_strength_policy_revision TEXT NOT NULL CHECK (
    length(identity_auth_strength_policy_revision) BETWEEN 1 AND 128
    AND identity_auth_strength_policy_revision ~ '^[A-Za-z0-9_.-]+$'
  ),
  locale_policy JSONB NOT NULL CHECK (jsonb_typeof(locale_policy)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(release_ref,site_ref)
);
CREATE INDEX authorization_site_release_active_idx
  ON platform.authorization_site_release(site_ref,state);

CREATE FUNCTION platform.reject_authorization_site_release_identity_brand_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.identity_issuer_label IS DISTINCT FROM OLD.identity_issuer_label
     OR NEW.identity_auth_strength_policy_revision IS DISTINCT FROM OLD.identity_auth_strength_policy_revision THEN
    RAISE EXCEPTION 'AUTHORIZATION_SITE_RELEASE_IDENTITY_BRAND_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.reject_authorization_site_release_identity_brand_mutation() FROM PUBLIC;
CREATE TRIGGER authorization_site_release_identity_brand_immutable
BEFORE UPDATE OF identity_issuer_label,identity_auth_strength_policy_revision
ON platform.authorization_site_release
FOR EACH ROW EXECUTE FUNCTION platform.reject_authorization_site_release_identity_brand_mutation();

CREATE TABLE platform.authorization_product_binding (
  binding_ref TEXT PRIMARY KEY,
  workload_identity_id TEXT NOT NULL UNIQUE,
  deployment_ref TEXT NOT NULL UNIQUE,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  release_ref TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','production')),
  region TEXT NOT NULL,
  audience TEXT NOT NULL,
  session_contract_revision TEXT NOT NULL,
  binding_epoch BIGINT NOT NULL CHECK (binding_epoch > 0),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(release_ref,site_ref)
    REFERENCES platform.authorization_site_release(release_ref,site_ref),
  UNIQUE(workload_identity_id,site_ref,release_ref)
);
CREATE INDEX authorization_product_binding_active_idx
  ON platform.authorization_product_binding(site_ref,state);

CREATE TABLE platform.authorization_subject (
  subject_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','disabled')),
  subject_generation BIGINT NOT NULL CHECK (subject_generation > 0),
  restriction_epoch BIGINT NOT NULL CHECK (restriction_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subject_ref,site_ref)
);
CREATE INDEX authorization_subject_active_idx ON platform.authorization_subject(site_ref,state);

CREATE TABLE platform.authorization_identity_session (
  session_ref TEXT PRIMARY KEY,
  subject_ref TEXT NOT NULL REFERENCES platform.authorization_subject(subject_ref),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  credential_digest CHAR(64) NOT NULL UNIQUE CHECK (credential_digest ~ '^[a-f0-9]{64}$'),
  authentication_methods TEXT[] NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  session_epoch BIGINT NOT NULL CHECK (session_epoch > 0),
  credential_epoch BIGINT NOT NULL CHECK (credential_epoch > 0),
  authenticated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(authentication_methods) BETWEEN 1 AND 3),
  CHECK (authentication_methods <@ ARRAY['password','totp','recovery_code']::TEXT[]),
  CHECK (expires_at > authenticated_at),
  UNIQUE(session_ref,subject_ref,site_ref)
);
CREATE INDEX authorization_identity_session_subject_idx
  ON platform.authorization_identity_session(subject_ref,state);
CREATE INDEX authorization_identity_session_site_expiry_idx
  ON platform.authorization_identity_session(site_ref,state,expires_at);

CREATE TABLE platform.authorization_project (
  project_ref TEXT PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  workspace_ref TEXT NOT NULL,
  execution_space_ref TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_ref,site_ref)
);
CREATE INDEX authorization_project_active_idx ON platform.authorization_project(site_ref,state);

CREATE TABLE platform.authorization_project_membership (
  project_ref TEXT NOT NULL REFERENCES platform.authorization_project(project_ref),
  subject_ref TEXT NOT NULL REFERENCES platform.authorization_subject(subject_ref),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  membership_epoch BIGINT NOT NULL CHECK (membership_epoch > 0),
  authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch > 0),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(project_ref,subject_ref)
);
CREATE INDEX authorization_membership_subject_idx
  ON platform.authorization_project_membership(subject_ref,state);
CREATE UNIQUE INDEX authorization_one_default_project_idx
  ON platform.authorization_project_membership(subject_ref)
  WHERE state='active' AND is_default;

CREATE TABLE platform.authorization_product_context (
  product_context_ref TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL REFERENCES platform.authorization_product_binding(binding_ref),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  release_ref TEXT NOT NULL REFERENCES platform.authorization_site_release(release_ref),
  snapshot_digest CHAR(64) NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  policy_epoch BIGINT NOT NULL CHECK (policy_epoch > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > issued_at)
);
CREATE INDEX authorization_product_context_binding_idx
  ON platform.authorization_product_context(binding_ref,expires_at DESC);

CREATE TABLE platform.authorization_session_access_grant (
  grant_ref UUID PRIMARY KEY,
  binding_ref TEXT NOT NULL REFERENCES platform.authorization_product_binding(binding_ref),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  subject_ref TEXT NOT NULL REFERENCES platform.authorization_subject(subject_ref),
  identity_session_ref TEXT NOT NULL REFERENCES platform.authorization_identity_session(session_ref),
  project_ref TEXT NOT NULL REFERENCES platform.authorization_project(project_ref),
  purpose TEXT NOT NULL CHECK (purpose IN ('read','write','control','stream')),
  audience TEXT NOT NULL CHECK (audience IN ('session.read','session.write','session.control','session.stream')),
  resource JSONB NOT NULL CHECK (jsonb_typeof(resource)='object'),
  claims_digest CHAR(64) NOT NULL CHECK (claims_digest ~ '^[a-f0-9]{64}$'),
  credential_digest CHAR(64) CHECK (credential_digest IS NULL OR credential_digest ~ '^[a-f0-9]{64}$'),
  key_revision TEXT NOT NULL,
  policy_epoch BIGINT NOT NULL CHECK (policy_epoch > 0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending','delivered','failed')),
  delivery_error_code TEXT,
  issued_at TIMESTAMPTZ NOT NULL,
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at AND expires_at > not_before AND expires_at-issued_at <= INTERVAL '5 minutes'),
  CHECK (
    (delivery_state='pending' AND credential_digest IS NULL AND delivered_at IS NULL AND failed_at IS NULL)
    OR (delivery_state='delivered' AND credential_digest IS NOT NULL AND delivered_at IS NOT NULL AND failed_at IS NULL)
    OR (delivery_state='failed' AND credential_digest IS NULL AND delivered_at IS NULL AND failed_at IS NOT NULL)
  )
);
CREATE INDEX authorization_grant_revocation_idx
  ON platform.authorization_session_access_grant(site_ref,revocation_epoch,expires_at);
CREATE INDEX authorization_grant_subject_idx
  ON platform.authorization_session_access_grant(subject_ref,expires_at);

REVOKE ALL ON
  platform.authorization_site,
  platform.authorization_site_release,
  platform.authorization_product_binding,
  platform.authorization_subject,
  platform.authorization_identity_session,
  platform.authorization_project,
  platform.authorization_project_membership,
  platform.authorization_product_context,
  platform.authorization_session_access_grant
FROM PUBLIC;
