SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Prelaunch hard cut: these are the exact transaction-local inputs consumed by
-- the Site publication DAG. Legacy platform.site_release is deliberately not a
-- source, fallback, bridge, or foreign-key target.
CREATE TABLE platform.site_publication_authority_bootstrap (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE),
  state TEXT NOT NULL CHECK (state IN ('open','sealed')),
  configuration_digest CHAR(64) CHECK (
    configuration_digest IS NULL OR configuration_digest ~ '^[0-9a-f]{64}$'
  ),
  sealed_at TIMESTAMPTZ,
  CHECK ((state='open' AND configuration_digest IS NULL AND sealed_at IS NULL) OR
         (state='sealed' AND configuration_digest IS NOT NULL AND sealed_at IS NOT NULL))
);
INSERT INTO platform.site_publication_authority_bootstrap(singleton,state) VALUES(TRUE,'open');

CREATE TABLE platform.site_effective_access_authority_revision (
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  profile_ref TEXT NOT NULL,
  profile_revision NUMERIC(20,0) NOT NULL
    CHECK (profile_revision BETWEEN 1 AND 18446744073709551615),
  profile_digest CHAR(71) NOT NULL CHECK (profile_digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_ref TEXT NOT NULL,
  catalog_revision NUMERIC(20,0) NOT NULL
    CHECK (catalog_revision BETWEEN 1 AND 18446744073709551615),
  catalog_digest CHAR(71) NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot_digest CHAR(71) NOT NULL CHECK (snapshot_digest ~ '^sha256:[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  configuration_digest CHAR(64) NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    site_ref,environment,profile_ref,profile_revision,profile_digest,
    catalog_ref,catalog_revision,catalog_digest
  ),
  UNIQUE (site_ref,environment,snapshot_digest),
  FOREIGN KEY (profile_ref,profile_revision,profile_digest)
    REFERENCES platform.launch_product_profile_revision(profile_revision_ref,revision,digest),
  FOREIGN KEY (catalog_ref,catalog_revision,catalog_digest)
    REFERENCES platform.product_surface_catalog_revision(catalog_revision_ref,revision,digest)
);

CREATE TABLE platform.site_web_build_intent_issuer_revision (
  authority_ref TEXT NOT NULL,
  authority_revision NUMERIC(20,0) NOT NULL
    CHECK (authority_revision BETWEEN 1 AND 18446744073709551615),
  authority_digest CHAR(71) NOT NULL CHECK (authority_digest ~ '^sha256:[0-9a-f]{64}$'),
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  web_composition_registry_ref TEXT NOT NULL,
  web_composition_registry_revision NUMERIC(20,0) NOT NULL
    CHECK (web_composition_registry_revision BETWEEN 1 AND 18446744073709551615),
  web_composition_registry_digest CHAR(71) NOT NULL
    CHECK (web_composition_registry_digest ~ '^sha256:[0-9a-f]{64}$'),
  web_build_toolchain_ref TEXT NOT NULL,
  web_build_toolchain_revision NUMERIC(20,0) NOT NULL
    CHECK (web_build_toolchain_revision BETWEEN 1 AND 18446744073709551615),
  web_build_toolchain_digest CHAR(71) NOT NULL
    CHECK (web_build_toolchain_digest ~ '^sha256:[0-9a-f]{64}$'),
  contract_floor JSONB NOT NULL CHECK (
    jsonb_typeof(contract_floor)='array' AND jsonb_array_length(contract_floor) BETWEEN 1 AND 128
  ),
  issuer_ref TEXT NOT NULL,
  producer_registry_ref TEXT NOT NULL,
  producer_registry_digest CHAR(71) NOT NULL
    CHECK (producer_registry_digest ~ '^sha256:[0-9a-f]{64}$'),
  producer_registry_epoch NUMERIC(20,0) NOT NULL
    CHECK (producer_registry_epoch BETWEEN 1 AND 18446744073709551615),
  trust_policy_ref TEXT NOT NULL,
  trust_policy_digest CHAR(71) NOT NULL CHECK (trust_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  trust_policy_epoch NUMERIC(20,0) NOT NULL
    CHECK (trust_policy_epoch BETWEEN 1 AND 18446744073709551615),
  signing_key_id TEXT NOT NULL,
  key_version NUMERIC(20,0) NOT NULL CHECK (key_version BETWEEN 1 AND 18446744073709551615),
  public_key_fingerprint CHAR(71) NOT NULL
    CHECK (public_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  key_valid_from TIMESTAMPTZ NOT NULL,
  key_valid_until TIMESTAMPTZ NOT NULL CHECK (key_valid_until>key_valid_from),
  configuration_digest CHAR(64) NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (authority_ref,authority_revision),
  UNIQUE (authority_ref,authority_revision,authority_digest),
  UNIQUE (site_ref,environment,authority_ref,authority_revision,authority_digest)
);

CREATE TABLE platform.site_web_build_intent_issuer_head (
  site_ref TEXT NOT NULL,
  environment TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  authority_revision NUMERIC(20,0) NOT NULL,
  authority_digest CHAR(71) NOT NULL,
  pointer_generation NUMERIC(20,0) NOT NULL DEFAULT 1
    CHECK (pointer_generation BETWEEN 1 AND 18446744073709551615),
  configuration_digest CHAR(64) NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (site_ref,environment),
  FOREIGN KEY (site_ref,environment,authority_ref,authority_revision,authority_digest)
    REFERENCES platform.site_web_build_intent_issuer_revision(
      site_ref,environment,authority_ref,authority_revision,authority_digest
    )
);

CREATE TABLE platform.site_web_build_intent_envelope (
  publication_kind TEXT NOT NULL DEFAULT 'web-build-intent'
    CHECK (publication_kind='web-build-intent'),
  intent_ref TEXT NOT NULL,
  intent_revision NUMERIC(20,0) NOT NULL
    CHECK (intent_revision BETWEEN 1 AND 18446744073709551615),
  intent_digest CHAR(71) NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload_type TEXT NOT NULL
    CHECK (payload_type='application/vnd.kokoro.web-build-intent.v1+json'),
  payload TEXT NOT NULL CHECK (
    octet_length(payload) BETWEEN 4 AND 1398104 AND payload ~ '^[A-Za-z0-9+/]+={0,2}$'
  ),
  signing_key_id TEXT NOT NULL CHECK (
    length(signing_key_id) BETWEEN 3 AND 200 AND
    signing_key_id ~ '^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)+$'
  ),
  signature TEXT NOT NULL CHECK (
    octet_length(signature)=88 AND signature ~ '^[A-Za-z0-9+/]{86}==$'
  ),
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  persisted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (intent_ref,intent_revision),
  UNIQUE (intent_ref,intent_revision,intent_digest),
  FOREIGN KEY (publication_kind,intent_ref,intent_revision,intent_digest)
    REFERENCES platform.site_publication_revision(publication_kind,revision_ref,revision,digest)
);

CREATE TABLE platform.site_release_producer_trust_revision (
  producer_identity_ref TEXT NOT NULL,
  producer_role TEXT NOT NULL CHECK (producer_role IN (
    'web-artifact-provenance-attestor','release-certification-authority'
  )),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  producer_registration_ref TEXT NOT NULL,
  producer_registration_revision NUMERIC(20,0) NOT NULL
    CHECK (producer_registration_revision BETWEEN 1 AND 18446744073709551615),
  producer_registration_digest CHAR(71) NOT NULL
    CHECK (producer_registration_digest ~ '^sha256:[0-9a-f]{64}$'),
  producer_registry_epoch NUMERIC(20,0) NOT NULL
    CHECK (producer_registry_epoch BETWEEN 1 AND 18446744073709551615),
  trust_policy_ref TEXT NOT NULL,
  trust_policy_revision NUMERIC(20,0) NOT NULL
    CHECK (trust_policy_revision BETWEEN 1 AND 18446744073709551615),
  trust_policy_digest CHAR(71) NOT NULL CHECK (trust_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  trust_policy_epoch NUMERIC(20,0) NOT NULL
    CHECK (trust_policy_epoch BETWEEN 1 AND 18446744073709551615),
  signing_key_id TEXT NOT NULL,
  signing_key_version NUMERIC(20,0) NOT NULL
    CHECK (signing_key_version BETWEEN 1 AND 18446744073709551615),
  signing_key_fingerprint CHAR(71) NOT NULL
    CHECK (signing_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  signature_domain TEXT NOT NULL,
  key_status TEXT NOT NULL CHECK (key_status IN ('active','revoked')),
  key_valid_from TIMESTAMPTZ NOT NULL,
  key_valid_until TIMESTAMPTZ NOT NULL CHECK (key_valid_until>key_valid_from),
  public_key_spki_pem TEXT NOT NULL CHECK (octet_length(public_key_spki_pem) BETWEEN 64 AND 16384),
  configuration_digest CHAR(64) NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer_identity_ref,producer_role,environment,signing_key_id,signing_key_version),
  UNIQUE (producer_identity_ref,producer_role,environment,producer_registration_ref,
    producer_registration_revision,producer_registration_digest,producer_registry_epoch,
    trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
    signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
    configuration_digest),
  CHECK ((producer_role='web-artifact-provenance-attestor' AND
          signature_domain='application/vnd.in-toto+json') OR
         (producer_role='release-certification-authority' AND
          signature_domain='application/vnd.kokoro.release-certification-instance.v1+json'))
);

CREATE TABLE platform.site_release_checker_trust_revision (
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  checker_role TEXT NOT NULL CHECK (checker_role IN ('artifact-inspection','journey','security')),
  checker_identity_ref TEXT NOT NULL,
  checker_registration_ref TEXT NOT NULL,
  checker_registration_revision NUMERIC(20,0) NOT NULL
    CHECK (checker_registration_revision BETWEEN 1 AND 18446744073709551615),
  checker_registration_digest CHAR(71) NOT NULL
    CHECK (checker_registration_digest ~ '^sha256:[0-9a-f]{64}$'),
  trust_policy_ref TEXT NOT NULL,
  trust_policy_revision NUMERIC(20,0) NOT NULL
    CHECK (trust_policy_revision BETWEEN 1 AND 18446744073709551615),
  trust_policy_digest CHAR(71) NOT NULL CHECK (trust_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  trust_policy_epoch NUMERIC(20,0) NOT NULL
    CHECK (trust_policy_epoch BETWEEN 1 AND 18446744073709551615),
  signing_key_id TEXT NOT NULL,
  signing_key_version NUMERIC(20,0) NOT NULL
    CHECK (signing_key_version BETWEEN 1 AND 18446744073709551615),
  signing_key_fingerprint CHAR(71) NOT NULL
    CHECK (signing_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  signature_domain TEXT NOT NULL
    CHECK (signature_domain='application/vnd.kokoro.release-evidence-decision.v1+json'),
  key_status TEXT NOT NULL CHECK (key_status IN ('active','revoked')),
  key_valid_from TIMESTAMPTZ NOT NULL,
  key_valid_until TIMESTAMPTZ NOT NULL CHECK (key_valid_until>key_valid_from),
  public_key_spki_pem TEXT NOT NULL CHECK (octet_length(public_key_spki_pem) BETWEEN 64 AND 16384),
  configuration_digest CHAR(64) NOT NULL CHECK (configuration_digest ~ '^[0-9a-f]{64}$'),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment,checker_role),
  UNIQUE (environment,checker_identity_ref),
  UNIQUE (environment,signing_key_fingerprint),
  UNIQUE (environment,checker_role,checker_identity_ref,checker_registration_ref,
    checker_registration_revision,checker_registration_digest,trust_policy_ref,
    trust_policy_revision,trust_policy_digest,trust_policy_epoch,signing_key_id,
    signing_key_version,signing_key_fingerprint,signature_domain,configuration_digest)
);

-- Certification is an independently supplied signed document. Its detached
-- envelope has a dedicated reader/table and is never mixed with machine
-- provenance or checker decisions.
CREATE TABLE platform.site_release_certification_envelope (
  certification_ref TEXT NOT NULL,
  certification_revision NUMERIC(20,0) NOT NULL
    CHECK (certification_revision BETWEEN 1 AND 18446744073709551615),
  certification_digest CHAR(71) NOT NULL CHECK (certification_digest ~ '^sha256:[0-9a-f]{64}$'),
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  producer_identity_ref TEXT NOT NULL,
  producer_role TEXT NOT NULL CHECK (producer_role='release-certification-authority'),
  producer_registration_ref TEXT NOT NULL,
  producer_registration_revision NUMERIC(20,0) NOT NULL,
  producer_registration_digest CHAR(71) NOT NULL,
  producer_registry_epoch NUMERIC(20,0) NOT NULL,
  trust_policy_ref TEXT NOT NULL,
  trust_policy_revision NUMERIC(20,0) NOT NULL,
  trust_policy_digest CHAR(71) NOT NULL,
  trust_policy_epoch NUMERIC(20,0) NOT NULL,
  signing_key_id TEXT NOT NULL,
  signing_key_version NUMERIC(20,0) NOT NULL,
  signing_key_fingerprint CHAR(71) NOT NULL,
  signature_domain TEXT NOT NULL
    CHECK (signature_domain='application/vnd.kokoro.release-certification-instance.v1+json'),
  producer_configuration_digest CHAR(64) NOT NULL,
  detached_signature BYTEA NOT NULL CHECK (octet_length(detached_signature)=64),
  admitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (certification_ref,certification_revision,certification_digest),
  FOREIGN KEY (producer_identity_ref,producer_role,environment,producer_registration_ref,
    producer_registration_revision,producer_registration_digest,producer_registry_epoch,
    trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
    signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
    producer_configuration_digest)
    REFERENCES platform.site_release_producer_trust_revision(
      producer_identity_ref,producer_role,environment,producer_registration_ref,
      producer_registration_revision,producer_registration_digest,producer_registry_epoch,
      trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
      signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
      configuration_digest
    )
);

CREATE TABLE platform.site_release_provenance_attestation (
  provenance_ref TEXT NOT NULL,
  provenance_revision NUMERIC(20,0) NOT NULL
    CHECK (provenance_revision BETWEEN 1 AND 18446744073709551615),
  provenance_digest CHAR(71) NOT NULL CHECK (provenance_digest ~ '^sha256:[0-9a-f]{64}$'),
  release_evidence_kind TEXT NOT NULL DEFAULT 'release-evidence'
    CHECK (release_evidence_kind='release-evidence'),
  release_evidence_ref TEXT NOT NULL,
  release_evidence_revision NUMERIC(20,0) NOT NULL,
  release_evidence_digest CHAR(71) NOT NULL,
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL,
  candidate_authorization_epoch NUMERIC(20,0) NOT NULL,
  candidate_digest CHAR(71) NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  environment TEXT NOT NULL CHECK (environment IN ('development','preview','staging','production')),
  compiled_web_manifest_ref TEXT NOT NULL,
  compiled_web_manifest_revision NUMERIC(20,0) NOT NULL,
  compiled_web_manifest_digest CHAR(71) NOT NULL,
  web_artifact_digest CHAR(71) NOT NULL CHECK (web_artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  artifact_inspection_evidence_ref TEXT NOT NULL,
  artifact_inspection_evidence_revision NUMERIC(20,0) NOT NULL,
  artifact_inspection_evidence_digest CHAR(71) NOT NULL,
  journey_evidence_ref TEXT NOT NULL,
  journey_evidence_revision NUMERIC(20,0) NOT NULL,
  journey_evidence_digest CHAR(71) NOT NULL,
  security_evidence_ref TEXT NOT NULL,
  security_evidence_revision NUMERIC(20,0) NOT NULL,
  security_evidence_digest CHAR(71) NOT NULL,
  producer_identity_ref TEXT NOT NULL,
  producer_role TEXT NOT NULL CHECK (producer_role='web-artifact-provenance-attestor'),
  producer_registration_ref TEXT NOT NULL,
  producer_registration_revision NUMERIC(20,0) NOT NULL,
  producer_registration_digest CHAR(71) NOT NULL,
  producer_registry_epoch NUMERIC(20,0) NOT NULL,
  trust_policy_ref TEXT NOT NULL,
  trust_policy_revision NUMERIC(20,0) NOT NULL,
  trust_policy_digest CHAR(71) NOT NULL,
  trust_policy_epoch NUMERIC(20,0) NOT NULL,
  signing_key_id TEXT NOT NULL,
  signing_key_version NUMERIC(20,0) NOT NULL,
  signing_key_fingerprint CHAR(71) NOT NULL,
  signature_domain TEXT NOT NULL CHECK (signature_domain='application/vnd.in-toto+json'),
  producer_configuration_digest CHAR(64) NOT NULL,
  provenance_canonical_payload BYTEA NOT NULL
    CHECK (octet_length(provenance_canonical_payload) BETWEEN 2 AND 4194304),
  provenance_payload_digest CHAR(71) NOT NULL
    CHECK (provenance_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_signature BYTEA NOT NULL CHECK (octet_length(provenance_signature)=64),
  workload_identity_ref TEXT NOT NULL,
  workload_attestation_ref TEXT NOT NULL,
  workload_attestation_revision NUMERIC(20,0) NOT NULL,
  workload_attestation_digest CHAR(71) NOT NULL,
  workload_authorization_epoch NUMERIC(20,0) NOT NULL,
  workload_revocation_epoch NUMERIC(20,0) NOT NULL CHECK (workload_revocation_epoch=0),
  workload_authorization_live_read_ref TEXT NOT NULL,
  workload_authorization_live_read_revision NUMERIC(20,0) NOT NULL,
  workload_authorization_live_read_digest CHAR(71) NOT NULL,
  workload_authorization_observed_at TIMESTAMPTZ NOT NULL,
  workload_authorization_valid_until TIMESTAMPTZ NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  admitted_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provenance_ref,provenance_revision,provenance_digest),
  UNIQUE (release_evidence_ref,release_evidence_revision,release_evidence_digest),
  UNIQUE (provenance_ref,provenance_revision,provenance_digest,candidate_ref,candidate_version,
    candidate_authorization_epoch,candidate_digest,site_ref,environment,web_artifact_digest,
    command_id),
  CHECK (provenance_payload_digest=provenance_digest),
  CHECK (workload_authorization_valid_until>workload_authorization_observed_at),
  FOREIGN KEY (release_evidence_kind,release_evidence_ref,release_evidence_revision,
    release_evidence_digest) REFERENCES platform.site_publication_revision(
      publication_kind,revision_ref,revision,digest
    ),
  FOREIGN KEY (candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest)
    REFERENCES platform.site_release_candidate_authority(
      candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest
    ),
  FOREIGN KEY (producer_identity_ref,producer_role,environment,producer_registration_ref,
    producer_registration_revision,producer_registration_digest,producer_registry_epoch,
    trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
    signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
    producer_configuration_digest)
    REFERENCES platform.site_release_producer_trust_revision(
      producer_identity_ref,producer_role,environment,producer_registration_ref,
      producer_registration_revision,producer_registration_digest,producer_registry_epoch,
      trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
      signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,
      configuration_digest
    )
);

CREATE TABLE platform.site_release_evidence_checker_decision (
  provenance_ref TEXT NOT NULL,
  provenance_revision NUMERIC(20,0) NOT NULL,
  provenance_digest CHAR(71) NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('artifact-inspection','journey','security')),
  decision_state TEXT NOT NULL CHECK (decision_state='passed'),
  candidate_ref TEXT NOT NULL,
  candidate_version NUMERIC(20,0) NOT NULL,
  candidate_authorization_epoch NUMERIC(20,0) NOT NULL,
  candidate_digest CHAR(71) NOT NULL,
  site_ref TEXT NOT NULL,
  environment TEXT NOT NULL,
  web_artifact_digest CHAR(71) NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_revision NUMERIC(20,0) NOT NULL,
  evidence_digest CHAR(71) NOT NULL,
  checker_identity_ref TEXT NOT NULL,
  checker_registration_ref TEXT NOT NULL,
  checker_registration_revision NUMERIC(20,0) NOT NULL,
  checker_registration_digest CHAR(71) NOT NULL,
  checker_role TEXT NOT NULL,
  trust_policy_ref TEXT NOT NULL,
  trust_policy_revision NUMERIC(20,0) NOT NULL,
  trust_policy_digest CHAR(71) NOT NULL,
  trust_policy_epoch NUMERIC(20,0) NOT NULL,
  signing_key_id TEXT NOT NULL,
  signing_key_version NUMERIC(20,0) NOT NULL,
  signing_key_fingerprint CHAR(71) NOT NULL,
  signature_domain TEXT NOT NULL
    CHECK (signature_domain='application/vnd.kokoro.release-evidence-decision.v1+json'),
  checker_configuration_digest CHAR(64) NOT NULL,
  decision_canonical_payload BYTEA NOT NULL
    CHECK (octet_length(decision_canonical_payload) BETWEEN 1 AND 65536),
  decision_payload_digest CHAR(71) NOT NULL
    CHECK (decision_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  decision_signature BYTEA NOT NULL CHECK (octet_length(decision_signature)=64),
  command_id TEXT NOT NULL REFERENCES platform.command_receipt(command_id),
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provenance_ref,provenance_revision,provenance_digest,evidence_kind),
  UNIQUE (provenance_ref,provenance_revision,provenance_digest,checker_identity_ref),
  UNIQUE (provenance_ref,provenance_revision,provenance_digest,signing_key_fingerprint),
  CHECK (evidence_kind=checker_role),
  FOREIGN KEY (provenance_ref,provenance_revision,provenance_digest,candidate_ref,
    candidate_version,candidate_authorization_epoch,candidate_digest,site_ref,environment,
    web_artifact_digest,command_id)
    REFERENCES platform.site_release_provenance_attestation(
      provenance_ref,provenance_revision,provenance_digest,candidate_ref,candidate_version,
      candidate_authorization_epoch,candidate_digest,site_ref,environment,web_artifact_digest,
      command_id
    ),
  FOREIGN KEY (environment,checker_role,checker_identity_ref,checker_registration_ref,
    checker_registration_revision,checker_registration_digest,trust_policy_ref,
    trust_policy_revision,trust_policy_digest,trust_policy_epoch,signing_key_id,
    signing_key_version,signing_key_fingerprint,signature_domain,checker_configuration_digest)
    REFERENCES platform.site_release_checker_trust_revision(
      environment,checker_role,checker_identity_ref,checker_registration_ref,
      checker_registration_revision,checker_registration_digest,trust_policy_ref,
      trust_policy_revision,trust_policy_digest,trust_policy_epoch,signing_key_id,
      signing_key_version,signing_key_fingerprint,signature_domain,configuration_digest
    )
);

CREATE FUNCTION platform.bootstrap_site_publication_authorities(
  p_document JSONB,
  p_configuration_digest CHAR(64)
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  bootstrap platform.site_publication_authority_bootstrap%ROWTYPE;
  item JSONB;
  environment_value TEXT;
  inserted_count INTEGER := 0;
BEGIN
  PERFORM set_config('app.site_publication_authority_bootstrap','true',true);
  SELECT * INTO bootstrap FROM platform.site_publication_authority_bootstrap
    WHERE singleton IS TRUE FOR UPDATE;
  IF bootstrap.state<>'open' THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_SEALED' USING ERRCODE='55000';
  END IF;
  IF p_configuration_digest IS NULL OR p_configuration_digest !~ '^[0-9a-f]{64}$'
     OR p_document IS NULL OR jsonb_typeof(p_document)<>'object'
     OR NOT (p_document ?& ARRAY['version','effectiveAccess','intentIssuers','producerTrust','checkerTrust'])
     OR p_document-ARRAY['version','effectiveAccess','intentIssuers','producerTrust','checkerTrust']::TEXT[]<>'{}'::JSONB
     OR p_document->>'version'<>'1'
     OR jsonb_typeof(p_document->'effectiveAccess')<>'array'
     OR jsonb_array_length(p_document->'effectiveAccess') NOT BETWEEN 1 AND 512
     OR jsonb_typeof(p_document->'intentIssuers')<>'array'
     OR jsonb_array_length(p_document->'intentIssuers') NOT BETWEEN 1 AND 512
     OR jsonb_typeof(p_document->'producerTrust')<>'array'
     OR jsonb_array_length(p_document->'producerTrust') NOT BETWEEN 2 AND 512
     OR jsonb_typeof(p_document->'checkerTrust')<>'array'
     OR jsonb_array_length(p_document->'checkerTrust') NOT BETWEEN 3 AND 512 THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_document->'effectiveAccess') LOOP
    IF jsonb_typeof(item)<>'object'
       OR NOT (item ?& ARRAY['siteRef','environment','launchProductProfile','productSurfaceCatalog',
                             'snapshotDigest','snapshot'])
       OR item-ARRAY['siteRef','environment','launchProductProfile','productSurfaceCatalog',
                     'snapshotDigest','snapshot']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'launchProductProfile')<>'object'
       OR NOT ((item->'launchProductProfile') ?& ARRAY['ref','revision','digest'])
       OR (item->'launchProductProfile')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'productSurfaceCatalog')<>'object'
       OR NOT ((item->'productSurfaceCatalog') ?& ARRAY['ref','revision','digest'])
       OR (item->'productSurfaceCatalog')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'snapshot')<>'object' THEN
      RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.site_effective_access_authority_revision(
      site_ref,environment,profile_ref,profile_revision,profile_digest,
      catalog_ref,catalog_revision,catalog_digest,snapshot_digest,snapshot,configuration_digest
    ) VALUES (
      item->>'siteRef',item->>'environment',item->'launchProductProfile'->>'ref',
      (item->'launchProductProfile'->>'revision')::NUMERIC,
      item->'launchProductProfile'->>'digest',item->'productSurfaceCatalog'->>'ref',
      (item->'productSurfaceCatalog'->>'revision')::NUMERIC,
      item->'productSurfaceCatalog'->>'digest',item->>'snapshotDigest',item->'snapshot',
      p_configuration_digest
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_document->'intentIssuers') LOOP
    IF jsonb_typeof(item)<>'object'
       OR NOT (item ?& ARRAY['authorityRef','authorityRevision','authorityDigest','siteRef','environment',
                             'webCompositionRegistry','webBuildToolchain','contractFloor','issuerRef',
                             'producerRegistry','producerRegistryEpoch','trustPolicy','trustPolicyEpoch',
                             'signingKeyId','keyVersion','publicKeyFingerprint','keyValidFrom',
                             'keyValidUntil'])
       OR item-ARRAY['authorityRef','authorityRevision','authorityDigest','siteRef','environment',
                     'webCompositionRegistry','webBuildToolchain','contractFloor','issuerRef',
                     'producerRegistry','producerRegistryEpoch','trustPolicy','trustPolicyEpoch',
                     'signingKeyId','keyVersion','publicKeyFingerprint','keyValidFrom',
                     'keyValidUntil']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'webCompositionRegistry')<>'object'
       OR NOT ((item->'webCompositionRegistry') ?& ARRAY['ref','revision','digest'])
       OR (item->'webCompositionRegistry')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'webBuildToolchain')<>'object'
       OR NOT ((item->'webBuildToolchain') ?& ARRAY['ref','revision','digest'])
       OR (item->'webBuildToolchain')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'producerRegistry')<>'object'
       OR NOT ((item->'producerRegistry') ?& ARRAY['ref','digest'])
       OR (item->'producerRegistry')-ARRAY['ref','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'trustPolicy')<>'object'
       OR NOT ((item->'trustPolicy') ?& ARRAY['ref','digest'])
       OR (item->'trustPolicy')-ARRAY['ref','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'contractFloor')<>'array'
       OR jsonb_array_length(item->'contractFloor') NOT BETWEEN 1 AND 128
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(item->'contractFloor') AS floor_entry(value)
         WHERE jsonb_typeof(floor_entry.value)<>'object'
           OR NOT (floor_entry.value ?& ARRAY['contractRef','minimumMajor'])
           OR floor_entry.value-ARRAY['contractRef','minimumMajor']::TEXT[]<>'{}'::JSONB
       ) THEN
      RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.site_web_build_intent_issuer_revision(
      authority_ref,authority_revision,authority_digest,site_ref,environment,
      web_composition_registry_ref,web_composition_registry_revision,
      web_composition_registry_digest,web_build_toolchain_ref,web_build_toolchain_revision,
      web_build_toolchain_digest,contract_floor,issuer_ref,producer_registry_ref,
      producer_registry_digest,producer_registry_epoch,trust_policy_ref,trust_policy_digest,
      trust_policy_epoch,signing_key_id,key_version,public_key_fingerprint,key_valid_from,
      key_valid_until,configuration_digest
    ) VALUES (
      item->>'authorityRef',(item->>'authorityRevision')::NUMERIC,item->>'authorityDigest',
      item->>'siteRef',item->>'environment',item->'webCompositionRegistry'->>'ref',
      (item->'webCompositionRegistry'->>'revision')::NUMERIC,
      item->'webCompositionRegistry'->>'digest',item->'webBuildToolchain'->>'ref',
      (item->'webBuildToolchain'->>'revision')::NUMERIC,item->'webBuildToolchain'->>'digest',
      item->'contractFloor',item->>'issuerRef',item->'producerRegistry'->>'ref',
      item->'producerRegistry'->>'digest',(item->>'producerRegistryEpoch')::NUMERIC,
      item->'trustPolicy'->>'ref',item->'trustPolicy'->>'digest',
      (item->>'trustPolicyEpoch')::NUMERIC,item->>'signingKeyId',(item->>'keyVersion')::NUMERIC,
      item->>'publicKeyFingerprint',(item->>'keyValidFrom')::TIMESTAMPTZ,
      (item->>'keyValidUntil')::TIMESTAMPTZ,p_configuration_digest
    );
    INSERT INTO platform.site_web_build_intent_issuer_head(
      site_ref,environment,authority_ref,authority_revision,authority_digest,configuration_digest
    ) VALUES (item->>'siteRef',item->>'environment',item->>'authorityRef',
      (item->>'authorityRevision')::NUMERIC,item->>'authorityDigest',p_configuration_digest);
    inserted_count := inserted_count + 1;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_document->'producerTrust') LOOP
    IF jsonb_typeof(item)<>'object'
       OR NOT (item ?& ARRAY['producerIdentityRef','producerRole','environment','producerRegistration',
                             'producerRegistryEpoch','trustPolicy','trustPolicyEpoch','signingKeyId',
                             'signingKeyVersion','signatureDomain','keyStatus','keyValidFrom',
                             'keyValidUntil','publicKeySpkiPem','signingKeyFingerprint'])
       OR item-ARRAY['producerIdentityRef','producerRole','environment','producerRegistration',
                     'producerRegistryEpoch','trustPolicy','trustPolicyEpoch','signingKeyId',
                     'signingKeyVersion','signatureDomain','keyStatus','keyValidFrom',
                     'keyValidUntil','publicKeySpkiPem','signingKeyFingerprint']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'producerRegistration')<>'object'
       OR NOT ((item->'producerRegistration') ?& ARRAY['ref','revision','digest'])
       OR (item->'producerRegistration')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'trustPolicy')<>'object'
       OR NOT ((item->'trustPolicy') ?& ARRAY['ref','revision','digest'])
       OR (item->'trustPolicy')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB THEN
      RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.site_release_producer_trust_revision(
      producer_identity_ref,producer_role,environment,producer_registration_ref,
      producer_registration_revision,producer_registration_digest,producer_registry_epoch,
      trust_policy_ref,trust_policy_revision,trust_policy_digest,trust_policy_epoch,
      signing_key_id,signing_key_version,signing_key_fingerprint,signature_domain,key_status,
      key_valid_from,key_valid_until,public_key_spki_pem,configuration_digest
    ) VALUES (
      item->>'producerIdentityRef',item->>'producerRole',item->>'environment',
      item->'producerRegistration'->>'ref',(item->'producerRegistration'->>'revision')::NUMERIC,
      item->'producerRegistration'->>'digest',(item->>'producerRegistryEpoch')::NUMERIC,
      item->'trustPolicy'->>'ref',(item->'trustPolicy'->>'revision')::NUMERIC,
      item->'trustPolicy'->>'digest',(item->>'trustPolicyEpoch')::NUMERIC,
      item->>'signingKeyId',(item->>'signingKeyVersion')::NUMERIC,item->>'signingKeyFingerprint',
      item->>'signatureDomain',item->>'keyStatus',(item->>'keyValidFrom')::TIMESTAMPTZ,
      (item->>'keyValidUntil')::TIMESTAMPTZ,item->>'publicKeySpkiPem',p_configuration_digest
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(p_document->'checkerTrust') LOOP
    IF jsonb_typeof(item)<>'object'
       OR NOT (item ?& ARRAY['checkerIdentityRef','checkerRole','environment','checkerRegistration',
                             'trustPolicy','trustPolicyEpoch','signingKeyId','signingKeyVersion',
                             'signingKeyFingerprint','signatureDomain','keyStatus','keyValidFrom',
                             'keyValidUntil','publicKeySpkiPem'])
       OR item-ARRAY['checkerIdentityRef','checkerRole','environment','checkerRegistration',
                     'trustPolicy','trustPolicyEpoch','signingKeyId','signingKeyVersion',
                     'signingKeyFingerprint','signatureDomain','keyStatus','keyValidFrom',
                     'keyValidUntil','publicKeySpkiPem']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'checkerRegistration')<>'object'
       OR NOT ((item->'checkerRegistration') ?& ARRAY['ref','revision','digest'])
       OR (item->'checkerRegistration')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB
       OR jsonb_typeof(item->'trustPolicy')<>'object'
       OR NOT ((item->'trustPolicy') ?& ARRAY['ref','revision','digest'])
       OR (item->'trustPolicy')-ARRAY['ref','revision','digest']::TEXT[]<>'{}'::JSONB THEN
      RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO platform.site_release_checker_trust_revision(
      environment,checker_role,checker_identity_ref,checker_registration_ref,
      checker_registration_revision,checker_registration_digest,trust_policy_ref,
      trust_policy_revision,trust_policy_digest,trust_policy_epoch,signing_key_id,
      signing_key_version,signing_key_fingerprint,signature_domain,key_status,key_valid_from,
      key_valid_until,public_key_spki_pem,configuration_digest
    ) VALUES (
      item->>'environment',item->>'checkerRole',item->>'checkerIdentityRef',
      item->'checkerRegistration'->>'ref',(item->'checkerRegistration'->>'revision')::NUMERIC,
      item->'checkerRegistration'->>'digest',item->'trustPolicy'->>'ref',
      (item->'trustPolicy'->>'revision')::NUMERIC,item->'trustPolicy'->>'digest',
      (item->>'trustPolicyEpoch')::NUMERIC,item->>'signingKeyId',
      (item->>'signingKeyVersion')::NUMERIC,item->>'signingKeyFingerprint',
      item->>'signatureDomain',item->>'keyStatus',(item->>'keyValidFrom')::TIMESTAMPTZ,
      (item->>'keyValidUntil')::TIMESTAMPTZ,item->>'publicKeySpkiPem',p_configuration_digest
    );
    inserted_count := inserted_count + 1;
  END LOOP;

  FOR environment_value IN
    SELECT DISTINCT environment FROM platform.site_release_producer_trust_revision
    WHERE configuration_digest=p_configuration_digest
  LOOP
    IF (SELECT COUNT(*)=3 AND COUNT(DISTINCT checker_identity_ref)=3 AND
               COUNT(DISTINCT signing_key_fingerprint)=3 AND COUNT(DISTINCT checker_role)=3
        FROM platform.site_release_checker_trust_revision
        WHERE environment=environment_value AND configuration_digest=p_configuration_digest)
       IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_CHECKER_SET_INVALID' USING ERRCODE='22023';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM platform.site_release_checker_trust_revision checker
    WHERE checker.configuration_digest=p_configuration_digest
      AND NOT EXISTS (
        SELECT 1 FROM platform.site_release_producer_trust_revision producer
        WHERE producer.configuration_digest=p_configuration_digest
          AND producer.environment=checker.environment
      )
  ) THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_CHECKER_SET_INVALID' USING ERRCODE='22023';
  END IF;

  UPDATE platform.site_publication_authority_bootstrap
     SET state='sealed',configuration_digest=p_configuration_digest,sealed_at=clock_timestamp()
   WHERE singleton IS TRUE AND state='open';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_SEALED' USING ERRCODE='55000';
  END IF;
  RETURN inserted_count;
END;
$$;

CREATE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SITE_PUBLICATION_RUNTIME_AUTHORITY_IMMUTABLE' USING ERRCODE='23000';
END;
$$;

CREATE FUNCTION platform.guard_site_publication_authority_bootstrap_seal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_TRANSITION_INVALID' USING ERRCODE='42501';
  END IF;
  IF current_setting('app.site_publication_authority_bootstrap',true)<>'true'
     OR OLD.state<>'open' OR NEW.state<>'sealed' OR OLD.singleton IS DISTINCT FROM NEW.singleton
     OR NEW.configuration_digest IS NULL OR NEW.sealed_at IS NULL THEN
    RAISE EXCEPTION 'SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_TRANSITION_INVALID' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER site_publication_authority_bootstrap_seal
  BEFORE UPDATE OR DELETE ON platform.site_publication_authority_bootstrap
  FOR EACH ROW EXECUTE FUNCTION platform.guard_site_publication_authority_bootstrap_seal();
CREATE TRIGGER site_effective_access_authority_immutable
  BEFORE UPDATE OR DELETE ON platform.site_effective_access_authority_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_web_build_intent_issuer_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.site_web_build_intent_issuer_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_web_build_intent_issuer_head_immutable
  BEFORE UPDATE OR DELETE ON platform.site_web_build_intent_issuer_head
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_web_build_intent_envelope_immutable
  BEFORE UPDATE OR DELETE ON platform.site_web_build_intent_envelope
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_release_producer_trust_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_producer_trust_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_release_checker_trust_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_checker_trust_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_release_certification_envelope_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_certification_envelope
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_release_provenance_attestation_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_provenance_attestation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();
CREATE TRIGGER site_release_evidence_checker_decision_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_evidence_checker_decision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation();

ALTER TABLE platform.site_publication_authority_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_publication_authority_bootstrap FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_effective_access_authority_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_effective_access_authority_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_issuer_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_issuer_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_issuer_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_issuer_head FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_web_build_intent_envelope FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_producer_trust_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_producer_trust_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_checker_trust_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_checker_trust_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_certification_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_certification_envelope FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_provenance_attestation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_provenance_attestation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_evidence_checker_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_evidence_checker_decision FORCE ROW LEVEL SECURITY;


-- Shared Site publication tables also have Admin policies. These narrow lease
-- predicates let those sessions evaluate Evidence policies as FALSE without
-- granting them the general Admission execution-root routine itself.
CREATE FUNCTION platform.site_evidence_resolver_role_is_current()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path=pg_catalog,platform
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM platform.runtime_role_identity_authority authority
    JOIN pg_catalog.pg_roles runtime_role
      ON runtime_role.oid::BIGINT=authority.role_oid
     AND runtime_role.rolname=authority.role_name
    WHERE authority.role_kind='admission'
      AND authority.lease_state='active'
      AND runtime_role.rolname=SESSION_USER
      AND current_setting('app.operation',true)='site.evidence.authorize'
      AND current_setting('app.workload_kind',true)='platform_admission'
      AND current_setting('app.admission_lease_epoch',true)=authority.lease_epoch::TEXT
  )
$function$;
REVOKE ALL ON FUNCTION platform.site_evidence_resolver_role_is_current() FROM PUBLIC;

CREATE FUNCTION platform.site_evidence_owner_role_is_current()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path=pg_catalog,platform
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM platform.runtime_role_identity_authority authority
    JOIN pg_catalog.pg_roles runtime_role
      ON runtime_role.oid::BIGINT=authority.role_oid
     AND runtime_role.rolname=authority.role_name
    WHERE authority.role_kind='admission'
      AND authority.lease_state='active'
      AND runtime_role.rolname=SESSION_USER
      AND current_setting('app.operation',true)='site.evidence.record'
      AND current_setting('app.workload_kind',true)='platform_worker'
      AND current_setting('app.admission_lease_epoch',true)=authority.lease_epoch::TEXT
  )
$function$;
REVOKE ALL ON FUNCTION platform.site_evidence_owner_role_is_current() FROM PUBLIC;

CREATE POLICY site_publication_authority_bootstrap_owner
  ON platform.site_publication_authority_bootstrap
  USING (current_setting('app.site_publication_authority_bootstrap',true)='true')
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');
CREATE POLICY site_effective_access_authority_bootstrap
  ON platform.site_effective_access_authority_revision FOR INSERT
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');
CREATE POLICY site_intent_issuer_revision_bootstrap
  ON platform.site_web_build_intent_issuer_revision FOR INSERT
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');
CREATE POLICY site_intent_issuer_head_bootstrap
  ON platform.site_web_build_intent_issuer_head FOR INSERT
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');
CREATE POLICY site_producer_trust_bootstrap
  ON platform.site_release_producer_trust_revision FOR INSERT
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');
CREATE POLICY site_checker_trust_bootstrap
  ON platform.site_release_checker_trust_revision FOR INSERT
  WITH CHECK (current_setting('app.site_publication_authority_bootstrap',true)='true');

-- The resolver proves the claimed live read before the Root request digest is
-- accepted. The owner rereads the same current binding under its mutation
-- transaction so revocation between resolution and commit fails closed.
CREATE POLICY site_project_binding_evidence_admission_read
  ON platform.site_project_binding FOR SELECT
  USING (
    platform.site_evidence_resolver_role_is_current() AND
    current_setting('app.workload_kind',true)='platform_admission' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.authorize' AND
    binding_ref=current_setting('app.site_project_binding_ref',true) AND
    binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT AND
    workload_identity_id=current_setting('app.workload_identity_ref',true) AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    region=current_setting('app.region',true) AND state='active'
  );
CREATE POLICY site_evidence_owner_live_binding
  ON platform.site_project_binding FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.workload_kind',true)='platform_worker' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.record' AND
    binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT AND
    workload_identity_id=current_setting('app.workload_identity_ref',true) AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    region=current_setting('app.region',true) AND state='active'
  );
CREATE POLICY site_evidence_producer_trust_read
  ON platform.site_release_producer_trust_revision FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    producer_role='web-artifact-provenance-attestor' AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='platform_worker' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.record' AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=NULLIF(current_setting('app.site_id',true),'')
        AND binding.environment=current_setting('app.environment',true)
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=current_setting('app.workload_identity_ref',true)
        AND binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT
        AND binding.state='active'
    )
  );
CREATE POLICY site_evidence_checker_trust_read
  ON platform.site_release_checker_trust_revision FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='platform_worker' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.record' AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=NULLIF(current_setting('app.site_id',true),'')
        AND binding.environment=site_release_checker_trust_revision.environment
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=current_setting('app.workload_identity_ref',true)
        AND binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT
        AND binding.state='active'
    )
  );
CREATE POLICY site_evidence_provenance_replay_read
  ON platform.site_release_provenance_attestation FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    workload_identity_ref=current_setting('app.workload_identity_ref',true) AND
    workload_authorization_epoch=current_setting('app.workload_binding_epoch',true)::NUMERIC(20,0)
  );
CREATE POLICY site_evidence_provenance_insert
  ON platform.site_release_provenance_attestation FOR INSERT
  WITH CHECK (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    current_setting('app.actor_kind',true)='workload' AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    workload_identity_ref=current_setting('app.workload_identity_ref',true) AND
    workload_authorization_epoch=current_setting('app.workload_binding_epoch',true)::NUMERIC(20,0) AND
    workload_revocation_epoch=0 AND
    workload_authorization_observed_at<=statement_timestamp() AND
    workload_authorization_observed_at>=statement_timestamp()-INTERVAL '30 seconds' AND
    statement_timestamp()<workload_authorization_valid_until AND
    workload_authorization_valid_until<=workload_authorization_observed_at+INTERVAL '30 seconds' AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=site_release_provenance_attestation.site_ref
        AND binding.environment=site_release_provenance_attestation.environment
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=site_release_provenance_attestation.workload_identity_ref
        AND binding.binding_epoch=site_release_provenance_attestation.workload_authorization_epoch
        AND binding.state='active'
    )
  );
CREATE POLICY site_evidence_decision_replay_read
  ON platform.site_release_evidence_checker_decision FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    EXISTS (
      SELECT 1 FROM platform.site_release_provenance_attestation provenance
      WHERE provenance.provenance_ref=site_release_evidence_checker_decision.provenance_ref
        AND provenance.provenance_revision=site_release_evidence_checker_decision.provenance_revision
        AND provenance.provenance_digest=site_release_evidence_checker_decision.provenance_digest
        AND provenance.candidate_ref=site_release_evidence_checker_decision.candidate_ref
        AND provenance.candidate_version=site_release_evidence_checker_decision.candidate_version
        AND provenance.candidate_authorization_epoch=
          site_release_evidence_checker_decision.candidate_authorization_epoch
        AND provenance.candidate_digest=site_release_evidence_checker_decision.candidate_digest
        AND provenance.site_ref=site_release_evidence_checker_decision.site_ref
        AND provenance.environment=site_release_evidence_checker_decision.environment
        AND provenance.web_artifact_digest=site_release_evidence_checker_decision.web_artifact_digest
        AND (
          (site_release_evidence_checker_decision.evidence_kind='artifact-inspection'
            AND provenance.artifact_inspection_evidence_ref=
              site_release_evidence_checker_decision.evidence_ref
            AND provenance.artifact_inspection_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.artifact_inspection_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest) OR
          (site_release_evidence_checker_decision.evidence_kind='journey'
            AND provenance.journey_evidence_ref=site_release_evidence_checker_decision.evidence_ref
            AND provenance.journey_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.journey_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest) OR
          (site_release_evidence_checker_decision.evidence_kind='security'
            AND provenance.security_evidence_ref=site_release_evidence_checker_decision.evidence_ref
            AND provenance.security_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.security_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest)
        )
        AND provenance.site_ref=NULLIF(current_setting('app.site_id',true),'')
        AND provenance.environment=current_setting('app.environment',true)
        AND provenance.workload_identity_ref=current_setting('app.workload_identity_ref',true)
    )
  );
CREATE POLICY site_evidence_decision_insert
  ON platform.site_release_evidence_checker_decision FOR INSERT
  WITH CHECK (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    decision_state='passed' AND
    EXISTS (
      SELECT 1 FROM platform.site_release_provenance_attestation provenance
      WHERE provenance.provenance_ref=site_release_evidence_checker_decision.provenance_ref
        AND provenance.provenance_revision=site_release_evidence_checker_decision.provenance_revision
        AND provenance.provenance_digest=site_release_evidence_checker_decision.provenance_digest
        AND provenance.command_id=site_release_evidence_checker_decision.command_id
        AND provenance.candidate_ref=site_release_evidence_checker_decision.candidate_ref
        AND provenance.candidate_version=site_release_evidence_checker_decision.candidate_version
        AND provenance.candidate_authorization_epoch=
          site_release_evidence_checker_decision.candidate_authorization_epoch
        AND provenance.candidate_digest=site_release_evidence_checker_decision.candidate_digest
        AND provenance.site_ref=site_release_evidence_checker_decision.site_ref
        AND provenance.environment=site_release_evidence_checker_decision.environment
        AND provenance.web_artifact_digest=site_release_evidence_checker_decision.web_artifact_digest
        AND (
          (site_release_evidence_checker_decision.evidence_kind='artifact-inspection'
            AND provenance.artifact_inspection_evidence_ref=
              site_release_evidence_checker_decision.evidence_ref
            AND provenance.artifact_inspection_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.artifact_inspection_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest) OR
          (site_release_evidence_checker_decision.evidence_kind='journey'
            AND provenance.journey_evidence_ref=site_release_evidence_checker_decision.evidence_ref
            AND provenance.journey_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.journey_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest) OR
          (site_release_evidence_checker_decision.evidence_kind='security'
            AND provenance.security_evidence_ref=site_release_evidence_checker_decision.evidence_ref
            AND provenance.security_evidence_revision=
              site_release_evidence_checker_decision.evidence_revision
            AND provenance.security_evidence_digest=
              site_release_evidence_checker_decision.evidence_digest)
        )
        AND provenance.site_ref=NULLIF(current_setting('app.site_id',true),'')
        AND provenance.workload_identity_ref=current_setting('app.workload_identity_ref',true)
    )
  );
CREATE POLICY site_evidence_candidate_read
  ON platform.site_release_candidate_authority FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=site_release_candidate_authority.site_ref
        AND binding.environment=site_release_candidate_authority.environment
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=current_setting('app.workload_identity_ref',true)
        AND binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT
        AND binding.state='active'
    )
  );
CREATE POLICY site_evidence_candidate_authorization_read
  ON platform.site_release_candidate_authorization FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    EXISTS (
      SELECT 1 FROM platform.site_release_candidate_authority candidate
      WHERE candidate.candidate_ref=site_release_candidate_authorization.candidate_ref
        AND candidate.candidate_version=site_release_candidate_authorization.candidate_version
        AND candidate.site_ref=NULLIF(current_setting('app.site_id',true),'')
        AND candidate.environment=current_setting('app.environment',true)
    )
  );
CREATE POLICY site_evidence_publication_read
  ON platform.site_publication_revision FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=site_publication_revision.site_ref
        AND binding.environment=current_setting('app.environment',true)
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=current_setting('app.workload_identity_ref',true)
        AND binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT
        AND binding.state='active'
    )
  );
CREATE POLICY site_evidence_publication_insert
  ON platform.site_publication_revision FOR INSERT
  WITH CHECK (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.operation',true)='site.evidence.record' AND
    publication_kind='release-evidence' AND producer_kind='workload-attested' AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    EXISTS (
      SELECT 1 FROM platform.site_project_binding binding
      WHERE binding.site_ref=site_publication_revision.site_ref
        AND binding.environment=current_setting('app.environment',true)
        AND binding.region=current_setting('app.region',true)
        AND binding.workload_identity_id=current_setting('app.workload_identity_ref',true)
        AND binding.binding_epoch=current_setting('app.workload_binding_epoch',true)::BIGINT
        AND binding.state='active'
    )
  );

CREATE POLICY site_effective_access_candidate_read
  ON platform.site_effective_access_authority_revision FOR SELECT
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-candidate.authorize');
CREATE POLICY site_intent_issuer_revision_admin_read
  ON platform.site_web_build_intent_issuer_revision FOR SELECT
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.web-build-intent.publish');
CREATE POLICY site_intent_issuer_head_admin_read
  ON platform.site_web_build_intent_issuer_head FOR SELECT
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.web-build-intent.publish');
CREATE POLICY site_web_build_intent_envelope_admin
  ON platform.site_web_build_intent_envelope
  USING (
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.web-build-intent.publish' AND
    EXISTS (
      SELECT 1 FROM platform.site_publication_revision publication
      WHERE publication.publication_kind='web-build-intent'
        AND publication.revision_ref=site_web_build_intent_envelope.intent_ref
        AND publication.revision=site_web_build_intent_envelope.intent_revision
        AND publication.digest=site_web_build_intent_envelope.intent_digest
        AND publication.site_ref=NULLIF(current_setting('app.site_id',true),'')
    )
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.web-build-intent.publish' AND
    EXISTS (
      SELECT 1 FROM platform.site_publication_revision publication
      WHERE publication.publication_kind='web-build-intent'
        AND publication.revision_ref=site_web_build_intent_envelope.intent_ref
        AND publication.revision=site_web_build_intent_envelope.intent_revision
        AND publication.digest=site_web_build_intent_envelope.intent_digest
        AND publication.site_ref=NULLIF(current_setting('app.site_id',true),'')
    )
  );
CREATE POLICY site_certification_trust_admin_read
  ON platform.site_release_producer_trust_revision FOR SELECT
  USING (producer_role='release-certification-authority' AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-certification.publish');
CREATE POLICY site_certification_envelope_admin_read
  ON platform.site_release_certification_envelope FOR SELECT
  USING (site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-certification.publish');

-- Product rows are immutable owner facts. Candidate assembly may read the exact
-- caller-approved binding but cannot publish or mutate Product owner state.
CREATE POLICY product_catalog_revision_site_candidate_read
  ON platform.product_surface_catalog_revision FOR SELECT
  USING (current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-candidate.authorize' AND
    NULLIF(current_setting('app.site_id',true),'') IS NOT NULL);
CREATE POLICY launch_product_profile_site_candidate_read
  ON platform.launch_product_profile_revision FOR SELECT
  USING (current_setting('app.workload_kind',true)='admin_workload' AND
    current_setting('app.actor_kind',true)='operator' AND
    current_setting('app.operation',true)='site.release-candidate.authorize' AND
    NULLIF(current_setting('app.site_id',true),'') IS NOT NULL);

REVOKE ALL ON TABLE platform.site_publication_authority_bootstrap FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_effective_access_authority_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_web_build_intent_issuer_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_web_build_intent_issuer_head FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_web_build_intent_envelope FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_producer_trust_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_checker_trust_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_certification_envelope FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_provenance_attestation FROM PUBLIC;
REVOKE ALL ON TABLE platform.site_release_evidence_checker_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.bootstrap_site_publication_authorities(JSONB, CHAR(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_immutable_site_publication_runtime_authority_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_site_publication_authority_bootstrap_seal() FROM PUBLIC;
