SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Prelaunch hard cut: the dormant kernel never had a production protector, so legacy envelope
-- bytes cannot be assigned a trustworthy nonce/tag/AAD after the fact.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform.memory_revision WHERE protected_ciphertext IS NOT NULL) THEN
    RAISE EXCEPTION 'MEMORY_PRELAUNCH_PROTECTED_PAYLOAD_RESET_REQUIRED';
  END IF;
END $$;

ALTER TABLE platform.memory_revision
  DROP COLUMN protected_ciphertext,
  DROP COLUMN protection_key_revision,
  DROP COLUMN envelope_digest;

CREATE TABLE platform.memory_revision_payload (
  site_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>0),
  revision_ref TEXT NOT NULL,
  envelope_version SMALLINT NOT NULL CHECK (envelope_version=1),
  protection_key_revision TEXT NOT NULL CHECK (length(protection_key_revision) BETWEEN 1 AND 256),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=12),
  protected_ciphertext BYTEA NOT NULL CHECK (octet_length(protected_ciphertext) BETWEEN 1 AND 16384),
  authentication_tag BYTEA NOT NULL CHECK (octet_length(authentication_tag)=16),
  aad_digest CHAR(64) NOT NULL CHECK (aad_digest ~ '^[a-f0-9]{64}$'),
  protected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (site_ref,space_ref,entry_ref,revision,revision_ref),
  FOREIGN KEY (site_ref,space_ref,entry_ref,revision,revision_ref)
    REFERENCES platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref)
    ON DELETE CASCADE
);

CREATE TABLE platform.memory_public_command_inbox (
  site_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  owner_scope_kind TEXT NOT NULL CHECK (owner_scope_kind IN ('user','project')),
  owner_subject_ref TEXT,
  owner_subject_generation BIGINT CHECK (owner_subject_generation>0),
  owner_project_ref TEXT,
  operation TEXT NOT NULL CHECK (operation IN (
    'remember','correct','restore','prioritize','deprioritize','forget','reset',
    'update_settings','request_import','request_export'
  )),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('accepted','completed','outcome_unknown','rejected')),
  safe_result_kind TEXT,
  result_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (site_ref,command_ref),
  FOREIGN KEY (site_ref) REFERENCES platform.authorization_site(site_ref),
  FOREIGN KEY (owner_subject_ref,site_ref)
    REFERENCES platform.authorization_subject(subject_ref,site_ref),
  FOREIGN KEY (owner_project_ref,site_ref)
    REFERENCES platform.authorization_project(project_ref,site_ref),
  CHECK (
    (owner_scope_kind='user' AND owner_subject_ref IS NOT NULL
      AND owner_subject_generation IS NOT NULL AND owner_project_ref IS NULL)
    OR
    (owner_scope_kind='project' AND owner_subject_ref IS NULL
      AND owner_subject_generation IS NULL AND owner_project_ref IS NOT NULL)
  ),
  CHECK ((state='completed')=(completed_at IS NOT NULL))
);

CREATE TABLE platform.memory_import_job (
  site_ref TEXT NOT NULL,
  import_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  owner_scope_kind TEXT NOT NULL CHECK (owner_scope_kind IN ('user','project')),
  owner_subject_ref TEXT,
  owner_subject_generation BIGINT CHECK (owner_subject_generation>0),
  owner_project_ref TEXT,
  upload_asset_ref TEXT NOT NULL,
  upload_asset_version_ref TEXT NOT NULL,
  upload_digest CHAR(64) NOT NULL CHECK (upload_digest ~ '^[a-f0-9]{64}$'),
  import_format TEXT NOT NULL CHECK (import_format='kokoro-memory-v1'),
  quarantine_object_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','quarantined','completed','rejected','purged')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  lease_token_hash CHAR(64),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at>=created_at),
  PRIMARY KEY (site_ref,import_ref),
  UNIQUE (site_ref,command_ref),
  FOREIGN KEY (site_ref,command_ref)
    REFERENCES platform.memory_public_command_inbox(site_ref,command_ref),
  CHECK ((lease_token_hash IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((owner_scope_kind='user' AND owner_subject_ref IS NOT NULL
      AND owner_subject_generation IS NOT NULL AND owner_project_ref IS NULL)
    OR (owner_scope_kind='project' AND owner_subject_ref IS NULL
      AND owner_subject_generation IS NULL AND owner_project_ref IS NOT NULL))
);

CREATE TABLE platform.memory_export_job (
  site_ref TEXT NOT NULL,
  export_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  owner_scope_kind TEXT NOT NULL CHECK (owner_scope_kind IN ('user','project')),
  owner_subject_ref TEXT,
  owner_subject_generation BIGINT CHECK (owner_subject_generation>0),
  owner_project_ref TEXT,
  snapshot_cutoff BIGINT NOT NULL CHECK (snapshot_cutoff>=0),
  export_format TEXT NOT NULL CHECK (export_format='kokoro-memory-v1'),
  artifact_request_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','leased','ready','failed','expired','purged')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  lease_token_hash CHAR(64),
  lease_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at>=created_at),
  PRIMARY KEY (site_ref,export_ref),
  UNIQUE (site_ref,command_ref),
  FOREIGN KEY (site_ref,command_ref)
    REFERENCES platform.memory_public_command_inbox(site_ref,command_ref),
  CHECK ((lease_token_hash IS NULL)=(lease_expires_at IS NULL)),
  CHECK ((state='ready')=(artifact_request_ref IS NOT NULL)),
  CHECK ((owner_scope_kind='user' AND owner_subject_ref IS NOT NULL
      AND owner_subject_generation IS NOT NULL AND owner_project_ref IS NULL)
    OR (owner_scope_kind='project' AND owner_subject_ref IS NULL
      AND owner_subject_generation IS NULL AND owner_project_ref IS NOT NULL))
);

CREATE TABLE platform.memory_purge_participant_manifest (
  manifest_version BIGINT NOT NULL CHECK (manifest_version>0),
  participant_key TEXT NOT NULL CHECK (participant_key IN (
    'revision_payload','public_presentation_cache','import_quarantine_object','export_object',
    'command_outbox_payload','backup_object_gc','lexical_index','selection_snapshot','context_use',
    'proposal_payload','embedding','ga_checkpoint_evidence'
  )),
  m0_applicability TEXT NOT NULL CHECK (m0_applicability IN ('applicable','not_applicable')),
  PRIMARY KEY (manifest_version,participant_key)
);
INSERT INTO platform.memory_purge_participant_manifest
  (manifest_version,participant_key,m0_applicability) VALUES
  (1,'revision_payload','applicable'),
  (1,'public_presentation_cache','applicable'),
  (1,'import_quarantine_object','applicable'),
  (1,'export_object','applicable'),
  (1,'command_outbox_payload','applicable'),
  (1,'backup_object_gc','applicable'),
  (1,'lexical_index','not_applicable'),
  (1,'selection_snapshot','not_applicable'),
  (1,'context_use','not_applicable'),
  (1,'proposal_payload','not_applicable'),
  (1,'embedding','not_applicable'),
  (1,'ga_checkpoint_evidence','not_applicable');

CREATE TABLE platform.memory_purge_job (
  site_ref TEXT NOT NULL,
  purge_job_ref TEXT NOT NULL,
  command_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  entry_ref TEXT,
  space_generation BIGINT NOT NULL CHECK (space_generation>0),
  learning_generation BIGINT NOT NULL CHECK (learning_generation>0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch>0),
  frozen_manifest_version BIGINT NOT NULL CHECK (frozen_manifest_version=1),
  revision_target_count BIGINT NOT NULL CHECK (revision_target_count>=0),
  revision_target_manifest_digest CHAR(64) NOT NULL
    CHECK (revision_target_manifest_digest ~ '^[a-f0-9]{64}$'),
  ingress_cutoff BIGINT NOT NULL CHECK (ingress_cutoff>=0),
  materialization_cutoff BIGINT NOT NULL CHECK (materialization_cutoff>=0),
  state TEXT NOT NULL CHECK (state IN ('queued','leased','running','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch>=0),
  lease_token_hash CHAR(64),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL CHECK (updated_at>=created_at),
  PRIMARY KEY (site_ref,purge_job_ref),
  UNIQUE (site_ref,command_ref),
  FOREIGN KEY (site_ref,space_ref) REFERENCES platform.memory_space(site_ref,space_ref),
  FOREIGN KEY (site_ref,command_ref)
    REFERENCES platform.memory_public_command_inbox(site_ref,command_ref),
  CHECK ((lease_token_hash IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL)
    OR (state IN ('leased','running') AND lease_token_hash IS NOT NULL
      AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX memory_purge_job_claim_idx
  ON platform.memory_purge_job(state,next_attempt_at,created_at,purge_job_ref);

-- Exact immutable membership, rather than a caller-provided cutoff comparison, is the deletion
-- authority. A revision created after this manifest is frozen can never become eligible.
CREATE TABLE platform.memory_purge_revision_target (
  site_ref TEXT NOT NULL,
  purge_job_ref TEXT NOT NULL,
  target_ordinal BIGINT NOT NULL CHECK (target_ordinal>=0),
  space_ref TEXT NOT NULL,
  entry_ref TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision>0),
  revision_ref TEXT NOT NULL,
  space_generation BIGINT NOT NULL CHECK (space_generation>0),
  learning_generation BIGINT NOT NULL CHECK (learning_generation>0),
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch>0),
  targeted_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (site_ref,purge_job_ref,target_ordinal),
  UNIQUE (site_ref,purge_job_ref,space_ref,entry_ref,revision,revision_ref),
  FOREIGN KEY (site_ref,purge_job_ref)
    REFERENCES platform.memory_purge_job(site_ref,purge_job_ref),
  FOREIGN KEY (site_ref,space_ref,entry_ref,revision,revision_ref)
    REFERENCES platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref),
  CHECK (deleted_at IS NULL OR deleted_at>=targeted_at)
);

CREATE TABLE platform.memory_purge_participant_receipt (
  site_ref TEXT NOT NULL,
  purge_job_ref TEXT NOT NULL,
  manifest_version BIGINT NOT NULL,
  participant_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','not_applicable')),
  receipt_ref TEXT NOT NULL,
  receipt_digest CHAR(64) NOT NULL CHECK (receipt_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (site_ref,purge_job_ref,participant_key),
  UNIQUE (site_ref,receipt_ref),
  FOREIGN KEY (site_ref,purge_job_ref)
    REFERENCES platform.memory_purge_job(site_ref,purge_job_ref),
  FOREIGN KEY (manifest_version,participant_key)
    REFERENCES platform.memory_purge_participant_manifest(manifest_version,participant_key)
);

CREATE TABLE platform.memory_suppression_tombstone (
  site_ref TEXT NOT NULL,
  suppression_ref TEXT NOT NULL,
  space_ref TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('fact','preference','profile')),
  space_generation BIGINT NOT NULL CHECK (space_generation>0),
  learning_generation BIGINT NOT NULL CHECK (learning_generation>0),
  private_key_epoch BIGINT NOT NULL CHECK (private_key_epoch>0),
  suppression_fingerprint BYTEA NOT NULL CHECK (octet_length(suppression_fingerprint)=32),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL CHECK (expires_at>created_at),
  PRIMARY KEY (site_ref,suppression_ref),
  UNIQUE (site_ref,space_ref,category,space_generation,learning_generation,
    private_key_epoch,suppression_fingerprint),
  FOREIGN KEY (site_ref,space_ref) REFERENCES platform.memory_space(site_ref,space_ref)
);

CREATE FUNCTION platform.reject_memory_revision_payload_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'MEMORY_REVISION_PAYLOAD_IMMUTABLE' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION platform.reject_memory_revision_payload_update() FROM PUBLIC;
CREATE TRIGGER reject_memory_revision_payload_update_trigger
  BEFORE UPDATE ON platform.memory_revision_payload
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_revision_payload_update();

CREATE FUNCTION platform.reject_memory_public_fact_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'MEMORY_PUBLIC_FACT_IMMUTABLE' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION platform.reject_memory_public_fact_mutation() FROM PUBLIC;
CREATE TRIGGER reject_memory_purge_manifest_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_purge_participant_manifest
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_public_fact_mutation();
CREATE TRIGGER reject_memory_purge_receipt_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_purge_participant_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_public_fact_mutation();
CREATE TRIGGER reject_memory_suppression_mutation_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_suppression_tombstone
  FOR EACH ROW EXECUTE FUNCTION platform.reject_memory_public_fact_mutation();

CREATE FUNCTION platform.guard_memory_purge_revision_target_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF TG_OP='DELETE'
    OR ROW(NEW.site_ref,NEW.purge_job_ref,NEW.target_ordinal,NEW.space_ref,NEW.entry_ref,
      NEW.revision,NEW.revision_ref,NEW.space_generation,NEW.learning_generation,
      NEW.revocation_epoch,NEW.targeted_at)
      IS DISTINCT FROM
      ROW(OLD.site_ref,OLD.purge_job_ref,OLD.target_ordinal,OLD.space_ref,OLD.entry_ref,
      OLD.revision,OLD.revision_ref,OLD.space_generation,OLD.learning_generation,
      OLD.revocation_epoch,OLD.targeted_at)
    OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'MEMORY_PURGE_REVISION_TARGET_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_memory_purge_revision_target_update() FROM PUBLIC;
CREATE TRIGGER guard_memory_purge_revision_target_update_trigger
  BEFORE UPDATE OR DELETE ON platform.memory_purge_revision_target
  FOR EACH ROW EXECUTE FUNCTION platform.guard_memory_purge_revision_target_update();

DO $$
DECLARE invalid_count BIGINT;
BEGIN
  SELECT count(*) INTO invalid_count FROM pg_roles role_row
   WHERE role_row.rolname IN ('platform_memory_public','platform_memory_runtime','platform_memory_worker')
     AND (NOT role_row.rolcanlogin OR role_row.rolinherit OR role_row.rolsuper
       OR role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolreplication
       OR role_row.rolbypassrls);
  IF invalid_count<>0 OR (SELECT count(*) FROM pg_roles WHERE rolname IN
      ('platform_memory_public','platform_memory_runtime','platform_memory_worker'))<>3 THEN
    RAISE EXCEPTION 'MEMORY_DATABASE_ROLE_ATTRIBUTES_INVALID';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members membership
      JOIN pg_roles member_role ON member_role.oid=membership.member
     WHERE member_role.rolname IN
      ('platform_memory_public','platform_memory_runtime','platform_memory_worker'))
    OR EXISTS (SELECT 1 FROM pg_auth_members membership
      JOIN pg_roles granted_role ON granted_role.oid=membership.roleid
     WHERE granted_role.rolname IN
      ('platform_memory_public','platform_memory_runtime','platform_memory_worker')) THEN
    RAISE EXCEPTION 'MEMORY_DATABASE_ROLE_MEMBERSHIP_INVALID';
  END IF;
  EXECUTE format('REVOKE CREATE,TEMPORARY ON DATABASE %I FROM '
    ||'platform_memory_public,platform_memory_runtime,platform_memory_worker',current_database());
END $$;
REVOKE CREATE,USAGE ON SCHEMA public FROM
  PUBLIC,platform_memory_public,platform_memory_runtime,platform_memory_worker;
REVOKE CREATE ON SCHEMA platform FROM
  platform_memory_public,platform_memory_runtime,platform_memory_worker;
REVOKE USAGE ON SCHEMA platform FROM platform_memory_runtime;
GRANT USAGE ON SCHEMA platform TO platform_memory_public,platform_memory_worker;

CREATE TABLE platform.memory_database_role_identity (
  role_kind TEXT PRIMARY KEY CHECK (role_kind IN ('public','runtime','worker')),
  role_name NAME NOT NULL UNIQUE,
  role_oid OID NOT NULL UNIQUE,
  CHECK ((role_kind='public' AND role_name='platform_memory_public')
    OR (role_kind='runtime' AND role_name='platform_memory_runtime')
    OR (role_kind='worker' AND role_name='platform_memory_worker'))
);
INSERT INTO platform.memory_database_role_identity(role_kind,role_name,role_oid)
SELECT 'public',rolname,oid FROM pg_roles WHERE rolname='platform_memory_public'
UNION ALL SELECT 'runtime',rolname,oid FROM pg_roles WHERE rolname='platform_memory_runtime'
UNION ALL SELECT 'worker',rolname,oid FROM pg_roles WHERE rolname='platform_memory_worker';

CREATE FUNCTION platform.assert_memory_database_role(expected_kind TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE expected_name NAME; expected_oid OID; actual_oid OID;
BEGIN
  SELECT role_name,role_oid INTO STRICT expected_name,expected_oid
    FROM platform.memory_database_role_identity WHERE role_kind=expected_kind;
  SELECT oid INTO STRICT actual_oid FROM pg_roles WHERE rolname=SESSION_USER;
  IF SESSION_USER<>expected_name::TEXT OR actual_oid<>expected_oid THEN
    RAISE EXCEPTION 'MEMORY_DATABASE_ROLE_FORBIDDEN';
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.assert_memory_database_role(TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_assert_public_owner_authority(
  p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,p_project_ref TEXT,
  p_membership_epoch BIGINT,p_authorization_epoch BIGINT,p_space_ref TEXT,
  p_feature_policy_revision_ref TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  IF p_site_ref IS NULL OR p_subject_ref IS NULL OR p_subject_generation IS NULL
    OR p_space_ref IS NULL OR p_feature_policy_revision_ref IS NULL
    OR NOT EXISTS (SELECT 1 FROM platform.authorization_site site
      WHERE site.site_ref=p_site_ref AND site.state='active')
    OR NOT EXISTS (SELECT 1 FROM platform.authorization_site_release release
      WHERE release.site_ref=p_site_ref AND release.state='active'
        AND release.feature_policy_revision=p_feature_policy_revision_ref)
    OR NOT EXISTS (SELECT 1 FROM platform.authorization_subject subject_row
      WHERE subject_row.site_ref=p_site_ref AND subject_row.subject_ref=p_subject_ref
        AND subject_row.subject_generation=p_subject_generation AND subject_row.state='active')
    OR NOT EXISTS (SELECT 1 FROM platform.memory_space space_row
      WHERE space_row.site_ref=p_site_ref AND space_row.space_ref=p_space_ref
        AND space_row.state='active'
        AND space_row.feature_policy_revision_ref=p_feature_policy_revision_ref
        AND ((p_project_ref IS NULL AND p_membership_epoch IS NULL AND p_authorization_epoch IS NULL
          AND space_row.scope_kind='user' AND space_row.subject_ref=p_subject_ref
          AND space_row.subject_generation=p_subject_generation AND space_row.project_ref IS NULL)
        OR (p_project_ref IS NOT NULL AND p_membership_epoch IS NOT NULL
          AND p_authorization_epoch IS NOT NULL AND space_row.scope_kind='project'
          AND space_row.project_ref=p_project_ref AND space_row.subject_ref IS NULL
          AND EXISTS (SELECT 1 FROM platform.authorization_project project
            JOIN platform.authorization_project_membership membership
              ON membership.project_ref=project.project_ref
           WHERE project.site_ref=p_site_ref AND project.project_ref=p_project_ref
             AND project.state='active' AND membership.subject_ref=p_subject_ref
             AND membership.state='active' AND membership.membership_epoch=p_membership_epoch
             AND membership.authorization_epoch=p_authorization_epoch)))) THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_OWNER_AUTHORITY_FORBIDDEN';
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.memory_assert_public_owner_authority(
  TEXT,TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_authorize_read(
  p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,p_project_ref TEXT,
  p_membership_epoch BIGINT,p_authorization_epoch BIGINT,p_space_ref TEXT,
  p_feature_policy_revision_ref TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.memory_assert_public_owner_authority(p_site_ref,p_subject_ref,
    p_subject_generation,p_project_ref,p_membership_epoch,p_authorization_epoch,p_space_ref,
    p_feature_policy_revision_ref);
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_authorize_read(
  TEXT,TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_public_authorize_read(
  TEXT,TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT) TO platform_memory_public;

CREATE FUNCTION platform.memory_public_authorize_command(
  p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,p_project_ref TEXT,
  p_membership_epoch BIGINT,p_authorization_epoch BIGINT,p_space_ref TEXT,
  p_feature_policy_revision_ref TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.memory_assert_public_owner_authority(p_site_ref,p_subject_ref,
    p_subject_generation,p_project_ref,p_membership_epoch,p_authorization_epoch,p_space_ref,
    p_feature_policy_revision_ref);
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_authorize_command(
  TEXT,TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_public_authorize_command(
  TEXT,TEXT,BIGINT,TEXT,BIGINT,BIGINT,TEXT,TEXT) TO platform_memory_public;

CREATE FUNCTION platform.memory_worker_claim_purge(
  p_worker_id TEXT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS TABLE(site_ref TEXT,purge_job_ref TEXT,lease_epoch BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_memory_database_role('worker');
  IF p_worker_id IS NULL OR length(p_worker_id) NOT BETWEEN 1 AND 256
    OR p_lease_token_hash !~ '^[a-f0-9]{64}$' OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'MEMORY_PURGE_LEASE_INVALID';
  END IF;
  RETURN QUERY WITH candidate AS (
    SELECT job.site_ref,job.purge_job_ref FROM platform.memory_purge_job job
     WHERE (job.state='queued' OR (job.state IN ('leased','running')
       AND job.lease_expires_at<=statement_timestamp()))
       AND job.next_attempt_at<=statement_timestamp()
     ORDER BY job.next_attempt_at,job.created_at,job.purge_job_ref
     FOR UPDATE SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE platform.memory_purge_job job SET state='leased',attempt_count=job.attempt_count+1,
      lease_epoch=job.lease_epoch+1,lease_token_hash=p_lease_token_hash,worker_id=p_worker_id,
      lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds),
      updated_at=statement_timestamp()
      FROM candidate WHERE job.site_ref=candidate.site_ref
        AND job.purge_job_ref=candidate.purge_job_ref AND job.attempt_count<100
      RETURNING job.site_ref,job.purge_job_ref,job.lease_epoch
  ) SELECT * FROM changed;
END $$;
REVOKE ALL ON FUNCTION platform.memory_worker_claim_purge(TEXT,CHAR,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_worker_claim_purge(TEXT,CHAR,INTEGER)
  TO platform_memory_worker;

CREATE FUNCTION platform.memory_worker_delete_revision_payload(
  p_purge_job_ref TEXT,p_site_ref TEXT,p_space_ref TEXT,p_entry_ref TEXT,p_revision BIGINT,
  p_revision_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64)
) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE job_row platform.memory_purge_job%ROWTYPE;
  target_row platform.memory_purge_revision_target%ROWTYPE;
  removed BIGINT;
BEGIN
  PERFORM platform.assert_memory_database_role('worker');
  SELECT * INTO STRICT job_row FROM platform.memory_purge_job job
   WHERE job.site_ref=p_site_ref AND job.purge_job_ref=p_purge_job_ref FOR UPDATE;
  IF job_row.space_ref<>p_space_ref
    OR (job_row.entry_ref IS NOT NULL AND job_row.entry_ref<>p_entry_ref)
    OR job_row.state NOT IN ('leased','running') OR job_row.lease_epoch<>p_lease_epoch
    OR job_row.lease_token_hash<>p_lease_token_hash
    OR job_row.lease_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'MEMORY_PURGE_LEASE_FENCE_INVALID';
  END IF;
  SELECT * INTO target_row FROM platform.memory_purge_revision_target target
   WHERE target.site_ref=p_site_ref AND target.purge_job_ref=p_purge_job_ref
     AND target.space_ref=p_space_ref AND target.entry_ref=p_entry_ref
     AND target.revision=p_revision AND target.revision_ref=p_revision_ref
   FOR UPDATE;
  IF NOT FOUND OR target_row.space_generation<>job_row.space_generation
    OR target_row.learning_generation<>job_row.learning_generation
    OR target_row.revocation_epoch<>job_row.revocation_epoch THEN
    RAISE EXCEPTION 'MEMORY_PURGE_TARGET_FORBIDDEN';
  END IF;
  IF target_row.deleted_at IS NOT NULL THEN RETURN 'already_deleted'; END IF;
  DELETE FROM platform.memory_revision_payload payload
   WHERE payload.site_ref=p_site_ref AND payload.space_ref=p_space_ref
     AND payload.entry_ref=p_entry_ref AND payload.revision=p_revision
     AND payload.revision_ref=p_revision_ref;
  GET DIAGNOSTICS removed=ROW_COUNT;
  IF removed<>1 THEN RAISE EXCEPTION 'MEMORY_PURGE_TARGET_PAYLOAD_MISSING'; END IF;
  UPDATE platform.memory_purge_revision_target target SET deleted_at=statement_timestamp()
   WHERE target.site_ref=p_site_ref AND target.purge_job_ref=p_purge_job_ref
     AND target.target_ordinal=target_row.target_ordinal;
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION platform.memory_worker_delete_revision_payload(
  TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_worker_delete_revision_payload(
  TEXT,TEXT,TEXT,TEXT,BIGINT,TEXT,BIGINT,CHAR) TO platform_memory_worker;

CREATE FUNCTION platform.memory_worker_record_purge_receipt(
  p_site_ref TEXT,p_purge_job_ref TEXT,p_participant_key TEXT,p_status TEXT,
  p_receipt_ref TEXT,p_receipt_digest CHAR(64),p_lease_epoch BIGINT,p_lease_token_hash CHAR(64)
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE job_row platform.memory_purge_job%ROWTYPE; expected_applicability TEXT;
BEGIN
  PERFORM platform.assert_memory_database_role('worker');
  SELECT * INTO STRICT job_row FROM platform.memory_purge_job job
   WHERE job.site_ref=p_site_ref AND job.purge_job_ref=p_purge_job_ref FOR UPDATE;
  IF job_row.state NOT IN ('leased','running') OR job_row.lease_epoch<>p_lease_epoch
    OR job_row.lease_token_hash<>p_lease_token_hash
    OR job_row.lease_expires_at<=statement_timestamp() THEN
    RAISE EXCEPTION 'MEMORY_PURGE_LEASE_FENCE_INVALID';
  END IF;
  SELECT manifest.m0_applicability INTO STRICT expected_applicability
    FROM platform.memory_purge_participant_manifest manifest
   WHERE manifest.manifest_version=job_row.frozen_manifest_version
     AND manifest.participant_key=p_participant_key;
  IF (expected_applicability='applicable' AND p_status<>'completed')
    OR (expected_applicability='not_applicable' AND p_status<>'not_applicable')
    OR p_receipt_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'MEMORY_PURGE_PARTICIPANT_RECEIPT_INVALID';
  END IF;
  IF p_participant_key='revision_payload' AND (
    (SELECT count(*) FROM platform.memory_purge_revision_target target
      WHERE target.site_ref=p_site_ref AND target.purge_job_ref=p_purge_job_ref)
      <>job_row.revision_target_count
    OR EXISTS (SELECT 1 FROM platform.memory_purge_revision_target target
      WHERE target.site_ref=p_site_ref AND target.purge_job_ref=p_purge_job_ref
        AND target.deleted_at IS NULL)) THEN
    RAISE EXCEPTION 'MEMORY_PURGE_REVISION_TARGETS_INCOMPLETE';
  END IF;
  INSERT INTO platform.memory_purge_participant_receipt(
    site_ref,purge_job_ref,manifest_version,participant_key,status,receipt_ref,receipt_digest,recorded_at)
  VALUES (p_site_ref,p_purge_job_ref,job_row.frozen_manifest_version,p_participant_key,
    p_status,p_receipt_ref,p_receipt_digest,statement_timestamp())
  ON CONFLICT (site_ref,purge_job_ref,participant_key) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM platform.memory_purge_participant_receipt receipt
    WHERE receipt.site_ref=p_site_ref AND receipt.purge_job_ref=p_purge_job_ref
      AND receipt.participant_key=p_participant_key AND receipt.status=p_status
      AND receipt.receipt_ref=p_receipt_ref AND receipt.receipt_digest=p_receipt_digest) THEN
    RAISE EXCEPTION 'MEMORY_PURGE_PARTICIPANT_RECEIPT_CONFLICT';
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.memory_worker_record_purge_receipt(
  TEXT,TEXT,TEXT,TEXT,TEXT,CHAR,BIGINT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.memory_worker_record_purge_receipt(
  TEXT,TEXT,TEXT,TEXT,TEXT,CHAR,BIGINT,CHAR) TO platform_memory_worker;

ALTER TABLE platform.memory_revision_payload ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_revision_payload FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_public_command_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_public_command_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_import_job FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_export_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_export_job FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_job FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_revision_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_revision_target FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_participant_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_participant_manifest FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_participant_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_purge_participant_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_suppression_tombstone ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_suppression_tombstone FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_database_role_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.memory_database_role_identity FORCE ROW LEVEL SECURITY;

CREATE POLICY memory_space_public_definer ON platform.memory_space TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_role_identity_definer ON platform.memory_database_role_identity
  TO platform_migrator USING (true);
CREATE POLICY memory_revision_payload_worker_definer ON platform.memory_revision_payload TO platform_migrator
  USING (SESSION_USER='platform_memory_worker') WITH CHECK (SESSION_USER='platform_memory_worker');
CREATE POLICY memory_purge_job_worker_definer ON platform.memory_purge_job TO platform_migrator
  USING (SESSION_USER='platform_memory_worker') WITH CHECK (SESSION_USER='platform_memory_worker');
CREATE POLICY memory_purge_target_worker_definer ON platform.memory_purge_revision_target
  TO platform_migrator USING (SESSION_USER='platform_memory_worker')
  WITH CHECK (SESSION_USER='platform_memory_worker');
CREATE POLICY memory_purge_manifest_worker_definer ON platform.memory_purge_participant_manifest TO platform_migrator
  USING (SESSION_USER='platform_memory_worker');
CREATE POLICY memory_purge_receipt_worker_definer ON platform.memory_purge_participant_receipt TO platform_migrator
  USING (SESSION_USER='platform_memory_worker') WITH CHECK (SESSION_USER='platform_memory_worker');

REVOKE ALL ON TABLE platform.memory_revision_payload FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_public_command_inbox FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_import_job FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_export_job FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_purge_job FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_purge_revision_target FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_purge_participant_manifest FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_purge_participant_receipt FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_suppression_tombstone FROM PUBLIC;
REVOKE ALL ON TABLE platform.memory_database_role_identity FROM PUBLIC;
