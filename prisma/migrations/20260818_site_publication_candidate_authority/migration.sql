SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- New unpublished authority. The legacy caller-authored site_release row is not
-- a source for this DAG and receives no bridge, dual-write or migration path.
CREATE TABLE platform.site_release_candidate_authority (
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL
    CHECK (candidate_version BETWEEN 1 AND 18446744073709551615),
  candidate_authorization_epoch NUMERIC(20,0) NOT NULL
    CHECK (candidate_authorization_epoch BETWEEN 1 AND 18446744073709551615),
  candidate_digest CHAR(71) NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  state TEXT NOT NULL CHECK (state='authorized'),
  profile_ref TEXT NOT NULL,
  profile_revision NUMERIC(20,0) NOT NULL
    CHECK (profile_revision BETWEEN 1 AND 18446744073709551615),
  profile_digest CHAR(71) NOT NULL CHECK (profile_digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_ref TEXT NOT NULL,
  catalog_revision NUMERIC(20,0) NOT NULL
    CHECK (catalog_revision BETWEEN 1 AND 18446744073709551615),
  catalog_digest CHAR(71) NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  business_bindings_digest CHAR(71) NOT NULL
    CHECK (business_bindings_digest ~ '^sha256:[0-9a-f]{64}$'),
  canonical_payload JSONB NOT NULL CHECK (jsonb_typeof(canonical_payload)='object'),
  canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 2 AND 4194304),
  authorized_by_command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  authorized_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (candidate_ref,candidate_version),
  UNIQUE (candidate_ref,candidate_version,candidate_digest),
  UNIQUE (candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest)
);

CREATE TABLE platform.site_release_candidate_authorization (
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL,
  candidate_digest CHAR(71) NOT NULL,
  authorization_epoch NUMERIC(20,0) NOT NULL
    CHECK (authorization_epoch BETWEEN 1 AND 18446744073709551615),
  state TEXT NOT NULL CHECK (state IN ('authorized','revoked')),
  updated_by_command_id TEXT NOT NULL REFERENCES platform.command_receipt(command_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (candidate_ref,candidate_version),
  FOREIGN KEY (candidate_ref,candidate_version,candidate_digest)
    REFERENCES platform.site_release_candidate_authority(
      candidate_ref,candidate_version,candidate_digest
    )
);

CREATE TABLE platform.site_publication_revision (
  publication_kind TEXT NOT NULL CHECK (publication_kind IN (
    'surface-inventory','web-build-material-bundle','web-build-intent','release-evidence',
    'release-certification','site-release'
  )),
  revision_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL CHECK (revision BETWEEN 1 AND 18446744073709551615),
  digest CHAR(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL,
  candidate_authorization_epoch NUMERIC(20,0) NOT NULL,
  candidate_digest CHAR(71) NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  producer_kind TEXT NOT NULL CHECK (producer_kind IN (
    'operator-approved','platform-issued','workload-attested','certifier-signed'
  )),
  canonical_payload JSONB NOT NULL CHECK (jsonb_typeof(canonical_payload)='object'),
  canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 2 AND 4194304),
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (publication_kind,revision_ref,revision),
  UNIQUE (publication_kind,revision_ref,revision,digest),
  UNIQUE (publication_kind,candidate_ref,candidate_version),
  FOREIGN KEY (candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest)
    REFERENCES platform.site_release_candidate_authority(
      candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest
    )
);
CREATE INDEX site_publication_revision_candidate
  ON platform.site_publication_revision(candidate_ref,candidate_version,publication_kind);

-- Mutable pointer is isolated from immutable SiteRelease. Rollback is a CAS to
-- an older immutable SiteRelease and advances generation; it never edits it.
CREATE TABLE platform.site_active_release_pointer (
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  generation NUMERIC(20,0) NOT NULL CHECK (generation BETWEEN 0 AND 18446744073709551615),
  active_release_kind TEXT NOT NULL DEFAULT 'site-release' CHECK (active_release_kind='site-release'),
  active_release_ref TEXT,
  active_release_revision NUMERIC(20,0),
  active_release_digest CHAR(71),
  authorization_epoch NUMERIC(20,0) NOT NULL
    CHECK (authorization_epoch BETWEEN 1 AND 18446744073709551615),
  updated_by_command_id TEXT REFERENCES platform.command_receipt(command_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (site_ref,environment),
  CHECK ((active_release_ref IS NULL AND active_release_revision IS NULL AND active_release_digest IS NULL) OR
         (active_release_ref IS NOT NULL AND active_release_revision BETWEEN 1 AND 18446744073709551615 AND
          active_release_digest ~ '^sha256:[0-9a-f]{64}$')),
  FOREIGN KEY (active_release_kind,active_release_ref,active_release_revision,active_release_digest)
    REFERENCES platform.site_publication_revision(publication_kind,revision_ref,revision,digest)
);

CREATE TABLE platform.site_activation_authority_snapshot (
  attempt_ref TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('begin','pre-cas')),
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL
    CHECK (candidate_version BETWEEN 1 AND 18446744073709551615),
  candidate_authorization_epoch NUMERIC(20,0) NOT NULL
    CHECK (candidate_authorization_epoch BETWEEN 1 AND 18446744073709551615),
  candidate_digest CHAR(71) NOT NULL CHECK (candidate_digest ~ '^sha256:[0-9a-f]{64}$'),
  release_kind TEXT NOT NULL DEFAULT 'site-release' CHECK (release_kind='site-release'),
  release_ref TEXT NOT NULL,
  release_revision NUMERIC(20,0) NOT NULL
    CHECK (release_revision BETWEEN 1 AND 18446744073709551615),
  release_digest CHAR(71) NOT NULL CHECK (release_digest ~ '^sha256:[0-9a-f]{64}$'),
  certification_revocation_epoch NUMERIC(20,0) NOT NULL
    CHECK (certification_revocation_epoch BETWEEN 0 AND 18446744073709551615),
  producer_registry_head_digest CHAR(71) NOT NULL
    CHECK (producer_registry_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  trust_policy_head_digest CHAR(71) NOT NULL
    CHECK (trust_policy_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  signing_key_head_digest CHAR(71) NOT NULL
    CHECK (signing_key_head_digest ~ '^sha256:[0-9a-f]{64}$'),
  active_pointer_generation NUMERIC(20,0) NOT NULL
    CHECK (active_pointer_generation BETWEEN 0 AND 18446744073709551615),
  attempt_digest CHAR(71) NOT NULL CHECK (attempt_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest CHAR(71) NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (attempt_ref,phase),
  UNIQUE (snapshot_digest),
  FOREIGN KEY (candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest)
    REFERENCES platform.site_release_candidate_authority(
      candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest
    ),
  FOREIGN KEY (release_kind,release_ref,release_revision,release_digest)
    REFERENCES platform.site_publication_revision(publication_kind,revision_ref,revision,digest)
);

CREATE TABLE platform.site_activation_eligibility_evidence (
  attempt_ref TEXT PRIMARY KEY,
  begin_snapshot_digest CHAR(71) NOT NULL UNIQUE
    REFERENCES platform.site_activation_authority_snapshot(snapshot_digest),
  pre_cas_snapshot_digest CHAR(71) NOT NULL UNIQUE
    REFERENCES platform.site_activation_authority_snapshot(snapshot_digest),
  eligibility_digest CHAR(71) NOT NULL UNIQUE
    CHECK (eligibility_digest ~ '^sha256:[0-9a-f]{64}$'),
  evaluated_at TIMESTAMPTZ NOT NULL,
  CHECK (begin_snapshot_digest<>pre_cas_snapshot_digest)
);

CREATE FUNCTION platform.reject_immutable_site_publication_authority_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_IMMUTABLE';
END;
$$;
CREATE TRIGGER site_release_candidate_authority_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_candidate_authority
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_authority_mutation();

CREATE FUNCTION platform.site_candidate_authorization_epoch_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.candidate_ref<>OLD.candidate_ref OR NEW.candidate_version<>OLD.candidate_version OR
     NEW.candidate_digest<>OLD.candidate_digest OR OLD.state<>'authorized' OR NEW.state<>'revoked' OR
     NEW.authorization_epoch<>OLD.authorization_epoch+1 OR
     NEW.updated_by_command_id=OLD.updated_by_command_id OR NEW.updated_at<=OLD.updated_at THEN
    RAISE EXCEPTION 'SITE_CANDIDATE_AUTHORIZATION_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER site_candidate_authorization_epoch_guard
  BEFORE UPDATE ON platform.site_release_candidate_authorization
  FOR EACH ROW EXECUTE FUNCTION platform.site_candidate_authorization_epoch_guard();
CREATE TRIGGER site_publication_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.site_publication_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_authority_mutation();
CREATE TRIGGER site_activation_authority_snapshot_immutable
  BEFORE UPDATE OR DELETE ON platform.site_activation_authority_snapshot
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_authority_mutation();
CREATE TRIGGER site_activation_eligibility_evidence_immutable
  BEFORE UPDATE OR DELETE ON platform.site_activation_eligibility_evidence
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_authority_mutation();

ALTER TABLE platform.site_release_candidate_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_candidate_authority FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_candidate_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_candidate_authorization FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_publication_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_publication_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_active_release_pointer ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_active_release_pointer FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_activation_authority_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_activation_authority_snapshot FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_activation_eligibility_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_activation_eligibility_evidence FORCE ROW LEVEL SECURITY;

CREATE POLICY site_release_candidate_scope ON platform.site_release_candidate_authority
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    ((current_setting('app.workload_kind',true)='admin_workload' AND
      current_setting('app.actor_kind',true)='operator' AND
      current_setting('app.operation',true) IN (
        'site.release-candidate.authorize','site.release-candidate.revoke',
        'site.surface-inventory.publish','site.web-build-material-bundle.publish',
        'site.web-build-intent.publish','site.release-certification.publish',
        'site.release.publish','site.activation.begin'
      )) OR
     (current_setting('app.workload_kind',true)='platform_worker' AND
      current_setting('app.actor_kind',true)='workload' AND
      current_setting('app.operation',true) IN
        ('site.release-evidence.publish','site.activation.commit'))))
  WITH CHECK (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-candidate.authorize');
CREATE POLICY site_release_candidate_authorization_scope
  ON platform.site_release_candidate_authorization
  USING (EXISTS (SELECT 1 FROM platform.site_release_candidate_authority candidate
    WHERE candidate.candidate_ref=site_release_candidate_authorization.candidate_ref
      AND candidate.candidate_version=site_release_candidate_authorization.candidate_version
      AND candidate.site_ref=NULLIF(current_setting('app.site_id',true),'')
      AND candidate.environment=current_setting('app.environment',true)
      AND ((current_setting('app.workload_kind',true)='admin_workload' AND
            current_setting('app.actor_kind',true)='operator' AND
            current_setting('app.operation',true) IN (
              'site.release-candidate.authorize','site.release-candidate.revoke',
              'site.surface-inventory.publish','site.web-build-material-bundle.publish',
              'site.web-build-intent.publish','site.release-certification.publish',
              'site.release.publish','site.activation.begin'
            )) OR
           (current_setting('app.workload_kind',true)='platform_worker' AND
            current_setting('app.actor_kind',true)='workload' AND
            current_setting('app.operation',true) IN
              ('site.release-evidence.publish','site.activation.commit')))))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.site_release_candidate_authority candidate
    WHERE candidate.candidate_ref=site_release_candidate_authorization.candidate_ref
      AND candidate.candidate_version=site_release_candidate_authorization.candidate_version
      AND candidate.site_ref=NULLIF(current_setting('app.site_id',true),'')
      AND candidate.environment=current_setting('app.environment',true)
      AND current_setting('app.workload_kind',true)='admin_workload'
      AND current_setting('app.actor_kind',true)='operator'
      AND ((current_setting('app.operation',true)='site.release-candidate.authorize' AND
            site_release_candidate_authorization.state='authorized' AND
            site_release_candidate_authorization.authorization_epoch=
              candidate.candidate_authorization_epoch) OR
           (current_setting('app.operation',true)='site.release-candidate.revoke' AND
            site_release_candidate_authorization.state='revoked'))));
CREATE POLICY site_publication_revision_scope ON platform.site_publication_revision
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND (
    (current_setting('app.workload_kind',true)='admin_workload' AND
     current_setting('app.actor_kind',true)='operator' AND
     current_setting('app.operation',true) IN (
       'site.surface-inventory.publish','site.web-build-material-bundle.publish',
       'site.web-build-intent.publish','site.release-certification.publish',
       'site.release.publish','site.activation.begin'
     )) OR
    (current_setting('app.workload_kind',true)='platform_worker' AND
     current_setting('app.actor_kind',true)='workload' AND
     current_setting('app.operation',true) IN
       ('site.release-evidence.publish','site.activation.commit'))
  ))
  WITH CHECK (site_ref=NULLIF(current_setting('app.site_id',true),'') AND (
    (current_setting('app.workload_kind',true)='admin_workload' AND
     current_setting('app.actor_kind',true)='operator' AND
     ((current_setting('app.operation',true)='site.surface-inventory.publish' AND
       publication_kind='surface-inventory' AND producer_kind='operator-approved') OR
      (current_setting('app.operation',true)='site.web-build-material-bundle.publish' AND
       publication_kind='web-build-material-bundle' AND producer_kind='operator-approved') OR
      (current_setting('app.operation',true)='site.web-build-intent.publish' AND
       publication_kind='web-build-intent' AND producer_kind='platform-issued') OR
      (current_setting('app.operation',true)='site.release-certification.publish' AND
       publication_kind='release-certification' AND producer_kind='certifier-signed') OR
      (current_setting('app.operation',true)='site.release.publish' AND
       publication_kind='site-release' AND producer_kind='platform-issued'))) OR
    (current_setting('app.workload_kind',true)='platform_worker' AND
     current_setting('app.actor_kind',true)='workload' AND
     current_setting('app.operation',true)='site.release-evidence.publish' AND
     publication_kind='release-evidence' AND producer_kind='workload-attested')
  ));
CREATE POLICY site_active_release_pointer_scope ON platform.site_active_release_pointer
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    ((current_setting('app.workload_kind',true)='platform_admin' AND
      current_setting('app.actor_kind',true)='operator' AND
      current_setting('app.operation',true)='site.activation.begin') OR
     (current_setting('app.workload_kind',true)='platform_worker' AND
      current_setting('app.actor_kind',true)='workload' AND
      current_setting('app.operation',true)='site.activation.commit')))
  WITH CHECK (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    ((current_setting('app.workload_kind',true)='platform_worker' AND
      current_setting('app.actor_kind',true)='workload' AND
      current_setting('app.operation',true)='site.activation.commit') OR
     (current_setting('app.workload_kind',true)='platform_admin' AND
      current_setting('app.actor_kind',true)='operator' AND
      current_setting('app.operation',true)='site.activation.begin' AND
      generation=0 AND active_release_ref IS NULL)));
CREATE POLICY site_activation_snapshot_scope ON platform.site_activation_authority_snapshot
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    ((current_setting('app.workload_kind',true)='platform_admin' AND
      current_setting('app.actor_kind',true)='operator' AND
      current_setting('app.operation',true)='site.activation.begin') OR
     (current_setting('app.workload_kind',true)='platform_worker' AND
      current_setting('app.actor_kind',true)='workload' AND
      current_setting('app.operation',true)='site.activation.commit')))
  WITH CHECK (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    ((current_setting('app.workload_kind',true)='platform_worker' AND
      current_setting('app.actor_kind',true)='workload' AND
      current_setting('app.operation',true)='site.activation.commit' AND phase='pre-cas') OR
     (current_setting('app.workload_kind',true)='platform_admin' AND
      current_setting('app.actor_kind',true)='operator' AND
      current_setting('app.operation',true)='site.activation.begin' AND phase='begin')));
CREATE POLICY site_activation_eligibility_scope ON platform.site_activation_eligibility_evidence
  USING (EXISTS (SELECT 1 FROM platform.site_activation_authority_snapshot snapshot
    WHERE snapshot.attempt_ref=site_activation_eligibility_evidence.attempt_ref
      AND snapshot.site_ref=NULLIF(current_setting('app.site_id',true),'')
      AND snapshot.environment=current_setting('app.environment',true)
      AND ((current_setting('app.workload_kind',true)='platform_admin' AND
            current_setting('app.actor_kind',true)='operator') OR
           (current_setting('app.workload_kind',true)='platform_worker' AND
            current_setting('app.actor_kind',true)='workload' AND
            current_setting('app.operation',true)='site.activation.commit'))))
  WITH CHECK (EXISTS (SELECT 1 FROM platform.site_activation_authority_snapshot snapshot
    WHERE snapshot.attempt_ref=site_activation_eligibility_evidence.attempt_ref
      AND snapshot.site_ref=NULLIF(current_setting('app.site_id',true),'')
      AND snapshot.environment=current_setting('app.environment',true)
      AND current_setting('app.workload_kind',true)='platform_worker'
      AND current_setting('app.actor_kind',true)='workload'
      AND current_setting('app.operation',true)='site.activation.commit'));

REVOKE ALL ON TABLE platform.site_release_candidate_authority FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_candidate_authorization FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_publication_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_active_release_pointer FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_activation_authority_snapshot FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_activation_eligibility_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_immutable_site_publication_authority_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.site_candidate_authorization_epoch_guard() FROM PUBLIC;
