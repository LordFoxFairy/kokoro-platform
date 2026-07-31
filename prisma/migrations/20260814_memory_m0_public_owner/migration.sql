SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.memory_entry
  ADD COLUMN prioritized BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT memory_entry_public_revision_bound_check
    CHECK (current_revision<=2147483647);
CREATE INDEX memory_entry_public_list_idx ON platform.memory_entry
  (site_ref,space_ref,state,prioritized DESC,updated_at DESC,entry_ref DESC);

ALTER TABLE platform.memory_revision
  ADD COLUMN restored_from_revision_ref TEXT,
  ADD COLUMN valid_from TIMESTAMPTZ,
  ADD COLUMN valid_to TIMESTAMPTZ,
  DROP CONSTRAINT memory_revision_reason_check,
  DROP CONSTRAINT memory_revision_check1,
  ADD CONSTRAINT memory_revision_reason_check
    CHECK (reason IN ('explicit','corrected','restored','imported')),
  ADD CONSTRAINT memory_revision_valid_range_check
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to>valid_from),
  ADD CONSTRAINT memory_revision_public_bound_check
    CHECK (revision<=2147483647),
  ADD CONSTRAINT memory_revision_lineage_check CHECK (
    (revision=1 AND reason IN ('explicit','imported') AND supersedes_revision IS NULL
      AND supersedes_revision_ref IS NULL AND restored_from_revision_ref IS NULL)
    OR
    (revision>1 AND reason='corrected' AND supersedes_revision=revision-1
      AND supersedes_revision_ref IS NOT NULL AND restored_from_revision_ref IS NULL)
    OR
    (revision>1 AND reason='restored' AND supersedes_revision=revision-1
      AND supersedes_revision_ref IS NOT NULL AND restored_from_revision_ref IS NOT NULL)
  ),
  ADD CONSTRAINT memory_revision_restored_from_fkey
    FOREIGN KEY (site_ref,restored_from_revision_ref)
    REFERENCES platform.memory_revision(site_ref,revision_ref);

ALTER TABLE platform.memory_provenance
  ADD COLUMN source_digest_key_revision TEXT;

CREATE OR REPLACE FUNCTION platform.guard_memory_entry_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state='deleted'
     OR ROW(OLD.site_ref,OLD.space_ref,OLD.entry_ref,OLD.category,
            OLD.feature_policy_revision_ref,OLD.space_generation,OLD.learning_generation,OLD.created_at)
        IS DISTINCT FROM
        ROW(NEW.site_ref,NEW.space_ref,NEW.entry_ref,NEW.category,
            NEW.feature_policy_revision_ref,NEW.space_generation,NEW.learning_generation,NEW.created_at)
     OR NEW.version<>OLD.version+1
     OR NEW.revocation_epoch<OLD.revocation_epoch
     OR NEW.updated_at<OLD.updated_at
     OR NOT (
       (NEW.state='active' AND NEW.current_revision=OLD.current_revision+1
         AND NEW.current_revision_ref<>OLD.current_revision_ref
         AND NEW.prioritized=OLD.prioritized
         AND NEW.revocation_epoch=OLD.revocation_epoch AND NEW.deleted_at IS NULL)
       OR
       (NEW.state='active' AND NEW.current_revision=OLD.current_revision
         AND NEW.current_revision_ref=OLD.current_revision_ref
         AND NEW.prioritized<>OLD.prioritized
         AND NEW.revocation_epoch=OLD.revocation_epoch AND NEW.deleted_at IS NULL)
       OR
       (NEW.state='deleted' AND NEW.current_revision=OLD.current_revision
         AND NEW.current_revision_ref=OLD.current_revision_ref
         AND NEW.prioritized=OLD.prioritized
         AND NEW.revocation_epoch>=OLD.revocation_epoch AND NEW.deleted_at=NEW.updated_at)
     ) THEN
    RAISE EXCEPTION 'MEMORY_ENTRY_UPDATE_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_memory_entry_update() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.validate_memory_entry_current_fence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE space_row platform.memory_space%ROWTYPE; parent_row platform.memory_space%ROWTYPE;
  parent_ref TEXT;
BEGIN
  SELECT parent_space_ref INTO parent_ref FROM platform.memory_space
   WHERE site_ref=NEW.site_ref AND space_ref=NEW.space_ref;
  IF parent_ref IS NOT NULL THEN
    SELECT * INTO parent_row FROM platform.memory_space
     WHERE site_ref=NEW.site_ref AND space_ref=parent_ref FOR UPDATE;
  END IF;
  SELECT * INTO space_row FROM platform.memory_space
   WHERE site_ref=NEW.site_ref AND space_ref=NEW.space_ref FOR UPDATE;
  IF NOT FOUND OR space_row.state<>'active'
     OR NEW.feature_policy_revision_ref<>space_row.feature_policy_revision_ref
     OR NEW.space_generation<>space_row.space_generation
     OR NEW.learning_generation<>space_row.learning_generation
     OR NEW.revocation_epoch>space_row.revocation_epoch
     OR (TG_OP='INSERT' AND NEW.revocation_epoch<>space_row.revocation_epoch)
     OR (TG_OP='UPDATE' AND OLD.state='active' AND OLD.revocation_epoch>space_row.revocation_epoch)
     OR (TG_OP='UPDATE' AND NEW.state='deleted'
       AND NEW.revocation_epoch<>space_row.revocation_epoch) THEN
    RAISE EXCEPTION 'MEMORY_ENTRY_FENCE_INVALID' USING ERRCODE='23514';
  END IF;
  IF space_row.scope_kind='agent_product' THEN
    IF parent_row.space_ref IS NULL OR parent_row.state<>'active'
       OR parent_row.space_generation<>space_row.parent_space_generation
       OR parent_row.learning_generation<>space_row.parent_learning_generation
       OR parent_row.revocation_epoch<>space_row.parent_revocation_epoch
       OR parent_row.feature_policy_revision_ref<>space_row.feature_policy_revision_ref THEN
      RAISE EXCEPTION 'MEMORY_PARENT_FENCE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.validate_memory_entry_current_fence() FROM PUBLIC;

ALTER TABLE platform.memory_command_receipt
  ADD COLUMN request_digest_key_revision TEXT,
  ADD CONSTRAINT memory_command_receipt_public_revision_bound_check
    CHECK (result_revision IS NULL OR result_revision<=2147483647),
  DROP CONSTRAINT memory_command_receipt_operation_check,
  DROP CONSTRAINT memory_command_receipt_result_kind_check,
  DROP CONSTRAINT memory_command_receipt_check1,
  DROP CONSTRAINT memory_command_receipt_check2,
  ADD CONSTRAINT memory_command_receipt_operation_check CHECK (operation IN (
    'remember','correct','restore','prioritize','deprioritize','forget','pause_learning',
    'resume_learning','pause_use','resume_use','reset','rebind_policy')),
  ADD CONSTRAINT memory_command_receipt_result_kind_check CHECK (result_kind IN (
    'remembered','corrected','restored','prioritized','deprioritized','forgotten',
    'learning_paused','learning_resumed','use_paused','use_resumed','reset','policy_rebound')),
  ADD CONSTRAINT memory_command_receipt_result_shape_check CHECK (
    (result_kind IN ('remembered','corrected','restored')
      AND result_entry_ref IS NOT NULL AND result_entry_version IS NOT NULL
      AND result_revision_ref IS NOT NULL AND result_revision IS NOT NULL
      AND result_space_generation IS NULL AND result_learning_generation IS NULL
      AND result_revocation_epoch IS NULL AND result_minimum_source_origin_seq IS NULL
      AND result_learning_state IS NULL AND result_use_state IS NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind IN ('prioritized','deprioritized')
      AND result_entry_ref IS NOT NULL AND result_entry_version IS NOT NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NULL AND result_learning_generation IS NULL
      AND result_revocation_epoch IS NULL AND result_minimum_source_origin_seq IS NULL
      AND result_learning_state IS NULL AND result_use_state IS NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind='forgotten' AND result_entry_ref IS NOT NULL AND result_entry_version IS NOT NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NULL AND result_learning_generation IS NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NULL
      AND result_learning_state IS NULL AND result_use_state IS NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind IN ('learning_paused','learning_resumed','use_paused','use_resumed','reset')
      AND result_entry_ref IS NULL AND result_entry_version IS NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NOT NULL AND result_learning_generation IS NOT NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NOT NULL
      AND result_learning_state IS NOT NULL AND result_use_state IS NOT NULL
      AND result_previous_feature_policy_revision_ref IS NULL
      AND result_feature_policy_revision_ref IS NULL)
    OR
    (result_kind='policy_rebound' AND result_entry_ref IS NULL AND result_entry_version IS NULL
      AND result_revision_ref IS NULL AND result_revision IS NULL
      AND result_space_generation IS NOT NULL AND result_learning_generation IS NOT NULL
      AND result_revocation_epoch IS NOT NULL AND result_minimum_source_origin_seq IS NOT NULL
      AND result_learning_state='paused' AND result_use_state='paused'
      AND result_previous_feature_policy_revision_ref IS NOT NULL
      AND result_feature_policy_revision_ref IS NOT NULL
      AND result_previous_feature_policy_revision_ref<>result_feature_policy_revision_ref)
  ),
  ADD CONSTRAINT memory_command_receipt_operation_result_check CHECK (
    (operation='remember' AND result_kind='remembered')
    OR (operation='correct' AND result_kind='corrected')
    OR (operation='restore' AND result_kind='restored')
    OR (operation='prioritize' AND result_kind='prioritized')
    OR (operation='deprioritize' AND result_kind='deprioritized')
    OR (operation='forget' AND result_kind='forgotten')
    OR (operation='pause_learning' AND result_kind='learning_paused')
    OR (operation='resume_learning' AND result_kind='learning_resumed')
    OR (operation='pause_use' AND result_kind='use_paused')
    OR (operation='resume_use' AND result_kind='use_resumed')
    OR (operation='reset' AND result_kind='reset')
    OR (operation='rebind_policy' AND result_kind='policy_rebound')
  );

ALTER TABLE platform.memory_public_command_inbox
  ADD COLUMN request_digest_key_revision TEXT NOT NULL,
  ADD COLUMN prepare_ref TEXT,
  ADD COLUMN expected_state_digest CHAR(64)
    CHECK (expected_state_digest IS NULL OR expected_state_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN committed_space_version BIGINT CHECK (committed_space_version>0),
  ADD COLUMN result_entry_ref TEXT,
  ADD COLUMN result_entry_version BIGINT CHECK (result_entry_version>0),
  ADD COLUMN result_revision BIGINT CHECK (result_revision>0),
  ADD COLUMN result_revision_ref TEXT,
  ADD CONSTRAINT memory_public_inbox_revision_bound_check
    CHECK (result_revision IS NULL OR result_revision<=2147483647),
  ADD CONSTRAINT memory_public_command_completion_shape_check CHECK (
    (state='completed' AND committed_space_version IS NOT NULL AND safe_result_kind IS NOT NULL)
    OR (state<>'completed' AND committed_space_version IS NULL)
  ),
  ADD CONSTRAINT memory_public_command_prepare_shape_check CHECK (
    (state='accepted' AND prepare_ref IS NOT NULL AND expected_state_digest IS NOT NULL)
    OR state<>'accepted'
  ),
  ADD CONSTRAINT memory_public_command_result_kind_check CHECK (
    (operation IN ('remember','correct','prioritize','deprioritize') AND safe_result_kind='entry')
    OR (operation='restore' AND safe_result_kind='restored')
    OR (operation IN ('forget','reset') AND safe_result_kind='purge')
    OR (operation IN ('update_settings','request_import','request_export'))
    OR (state<>'completed' AND safe_result_kind IS NULL)
  );

CREATE FUNCTION platform.memory_public_personal_owner_internal(
  p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,
  p_feature_policy_revision_ref TEXT,p_candidate_space_ref TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE space_row platform.memory_space%ROWTYPE;
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  IF p_site_ref IS NULL OR p_subject_ref IS NULL OR p_subject_generation IS NULL
    OR p_subject_generation<=0 OR p_feature_policy_revision_ref IS NULL
    OR p_candidate_space_ref IS NULL
    OR NOT EXISTS (SELECT 1 FROM platform.authorization_site site
      WHERE site.site_ref=p_site_ref AND site.state='active')
    OR NOT EXISTS (SELECT 1 FROM platform.site site_owner
      JOIN platform.site_release release
        ON release.site_ref=site_owner.site_ref
       AND release.release_ref=site_owner.active_release_ref
       AND release.state='active'
       AND release.feature_policy_revision=p_feature_policy_revision_ref
      JOIN platform.authorization_site_release authorization_release
        ON authorization_release.site_ref=release.site_ref
       AND authorization_release.release_ref=release.release_ref
       AND authorization_release.state='active'
       AND authorization_release.feature_policy_revision=release.feature_policy_revision
      WHERE site_owner.site_ref=p_site_ref AND site_owner.state='active'
        AND site_owner.tombstoned_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM platform.authorization_subject subject_row
      WHERE subject_row.site_ref=p_site_ref AND subject_row.subject_ref=p_subject_ref
        AND subject_row.subject_generation=p_subject_generation AND subject_row.state='active') THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_NOT_AVAILABLE';
  END IF;
  SELECT * INTO space_row FROM platform.memory_space space
   WHERE space.site_ref=p_site_ref AND space.scope_kind='user'
     AND space.subject_ref=p_subject_ref AND space.subject_generation=p_subject_generation
     AND space.parent_space_ref IS NULL AND space.project_ref IS NULL
     AND space.agent_option_ref IS NULL AND space.product_surface_ref IS NULL
     AND space.state='active' LIMIT 2;
  IF FOUND THEN
    IF space_row.space_ref<>p_candidate_space_ref
      OR space_row.feature_policy_revision_ref<>p_feature_policy_revision_ref THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_NOT_AVAILABLE';
    END IF;
    RETURN jsonb_build_object('spaceRef',space_row.space_ref,
      'spaceVersion',space_row.version::TEXT,'persisted',true);
  END IF;
  IF EXISTS (SELECT 1 FROM platform.memory_space occupied
    WHERE occupied.site_ref=p_site_ref AND occupied.space_ref=p_candidate_space_ref) THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_NOT_AVAILABLE';
  END IF;
  RETURN jsonb_build_object('spaceRef',p_candidate_space_ref,'spaceVersion','1','persisted',false);
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_personal_owner_internal(TEXT,TEXT,BIGINT,TEXT,TEXT)
  FROM PUBLIC;

CREATE FUNCTION platform.memory_public_space_state_internal(p_site_ref TEXT,p_space_ref TEXT)
RETURNS JSONB LANGUAGE sql STABLE SET search_path=pg_catalog,platform AS $$
SELECT jsonb_build_object('spaceRef',space.space_ref,'binding',jsonb_build_object(
  'kind','user','siteRef',space.site_ref,'subjectRef',space.subject_ref,
  'subjectGeneration',space.subject_generation::TEXT),
  'featurePolicyRevisionRef',space.feature_policy_revision_ref,'version',space.version::TEXT,
  'spaceGeneration',space.space_generation::TEXT,
  'learningGeneration',space.learning_generation::TEXT,
  'revocationEpoch',space.revocation_epoch::TEXT,
  'minimumLearnableSourceOriginSequence',space.minimum_learnable_source_origin_seq::TEXT,
  'learningState',space.learning_state,'useState',space.use_state,'state',space.state,
  'createdAt',space.created_at,'updatedAt',space.updated_at)
FROM platform.memory_space space WHERE space.site_ref=p_site_ref AND space.space_ref=p_space_ref
  AND space.scope_kind='user'
$$;
REVOKE ALL ON FUNCTION platform.memory_public_space_state_internal(TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_entry_state_internal(
  p_site_ref TEXT,p_space_ref TEXT,p_entry_ref TEXT
) RETURNS JSONB LANGUAGE sql STABLE SET search_path=pg_catalog,platform AS $$
SELECT jsonb_build_object('siteRef',entry.site_ref,'spaceRef',entry.space_ref,
  'entryRef',entry.entry_ref,'version',entry.version::TEXT,
  'currentRevision',entry.current_revision::TEXT,'currentRevisionRef',entry.current_revision_ref,
  'state',entry.state,'category',entry.category,
  'featurePolicyRevisionRef',entry.feature_policy_revision_ref,
  'spaceGeneration',entry.space_generation::TEXT,
  'learningGeneration',entry.learning_generation::TEXT,
  'revocationEpoch',entry.revocation_epoch::TEXT,
  'createdAt',entry.created_at,'updatedAt',entry.updated_at,'deletedAt',entry.deleted_at)
FROM platform.memory_entry entry WHERE entry.site_ref=p_site_ref
 AND entry.space_ref=p_space_ref AND entry.entry_ref=p_entry_ref
$$;
REVOKE ALL ON FUNCTION platform.memory_public_entry_state_internal(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_prepare_command_internal(
  p_operation TEXT,p_site_ref TEXT,p_subject_ref TEXT,p_subject_generation BIGINT,
  p_feature_policy_revision_ref TEXT,p_command_ref TEXT,p_request_digest CHAR(64),
  p_request_digest_key_revision TEXT,p_space_ref TEXT,p_entry_ref TEXT,p_revision_ref TEXT
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE owner_result JSONB; inbox_row platform.memory_public_command_inbox%ROWTYPE;
  space_state JSONB; entry_state JSONB; v_state_digest CHAR(64); v_prepare_ref TEXT;
  had_inbox BOOLEAN;
BEGIN
  IF p_operation NOT IN ('remember','correct','restore','prioritize','deprioritize','forget','reset')
    OR p_command_ref IS NULL OR length(p_command_ref) NOT BETWEEN 3 AND 256
    OR p_request_digest !~ '^[a-f0-9]{64}$'
    OR p_request_digest_key_revision IS NULL
    OR length(p_request_digest_key_revision) NOT BETWEEN 3 AND 128 THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_INVALID';
  END IF;
  owner_result:=platform.memory_public_personal_owner_internal(p_site_ref,p_subject_ref,
    p_subject_generation,p_feature_policy_revision_ref,p_space_ref);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    concat_ws(E'\x1f',p_site_ref,p_subject_ref,p_subject_generation::TEXT,p_command_ref),
    5570193304977555316));
  SELECT * INTO inbox_row FROM platform.memory_public_command_inbox inbox
   WHERE inbox.site_ref=p_site_ref AND inbox.command_ref=p_command_ref FOR UPDATE;
  had_inbox:=FOUND;
  IF FOUND THEN
    IF inbox_row.owner_scope_kind<>'user' OR inbox_row.owner_subject_ref<>p_subject_ref
      OR inbox_row.owner_subject_generation<>p_subject_generation
      OR inbox_row.owner_project_ref IS NOT NULL OR inbox_row.operation<>p_operation
      OR inbox_row.request_digest<>p_request_digest
      OR inbox_row.request_digest_key_revision<>p_request_digest_key_revision THEN
      RETURN jsonb_build_object('decision','digest_conflict');
    END IF;
    IF inbox_row.state='completed' THEN
      RETURN jsonb_build_object('decision','replay','kind',inbox_row.safe_result_kind,
        'spaceRef',owner_result->>'spaceRef',
        'committedSpaceVersion',inbox_row.committed_space_version::TEXT,
        'entryRef',inbox_row.result_entry_ref,
        'entryVersion',inbox_row.result_entry_version::TEXT,
        'revision',inbox_row.result_revision::TEXT,
        'revisionRef',inbox_row.result_revision_ref);
    END IF;
    IF inbox_row.state<>'accepted' THEN RETURN jsonb_build_object('decision','outcome_unknown'); END IF;
  END IF;
  space_state:=platform.memory_public_space_state_internal(p_site_ref,p_space_ref);
  entry_state:=CASE WHEN p_operation IN ('correct','restore','prioritize','deprioritize','forget')
    THEN platform.memory_public_entry_state_internal(p_site_ref,p_space_ref,p_entry_ref) ELSE NULL END;
  v_state_digest:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,
    'space',space_state,'entry',entry_state)::TEXT,'UTF8')),'hex');
  v_prepare_ref:='memory-prepare:'||encode(sha256(convert_to(concat_ws(E'\x1f',p_site_ref,
    p_command_ref,v_state_digest,clock_timestamp()::TEXT,random()::TEXT),'UTF8')),'hex');
  IF had_inbox THEN
    UPDATE platform.memory_public_command_inbox SET prepare_ref=v_prepare_ref,
      expected_state_digest=v_state_digest WHERE site_ref=p_site_ref AND command_ref=p_command_ref;
  ELSE
    INSERT INTO platform.memory_public_command_inbox(site_ref,command_ref,owner_scope_kind,
      owner_subject_ref,owner_subject_generation,owner_project_ref,operation,request_digest,
      request_digest_key_revision,state,prepare_ref,expected_state_digest,created_at)
    VALUES (p_site_ref,p_command_ref,'user',p_subject_ref,p_subject_generation,NULL,
      p_operation,p_request_digest,p_request_digest_key_revision,'accepted',v_prepare_ref,
      v_state_digest,statement_timestamp());
  END IF;
  RETURN owner_result || jsonb_build_object('decision','claimed','entryRef',p_entry_ref,
    'revisionRef',p_revision_ref,'prepareRef',v_prepare_ref,'expectedStateDigest',v_state_digest,
    'spaceState',space_state,'entryState',entry_state);
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_prepare_command_internal(
  TEXT,TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_entry_json(
  p_site_ref TEXT,p_space_ref TEXT,p_entry_ref TEXT
) RETURNS JSONB LANGUAGE sql STABLE SET search_path=pg_catalog,platform AS $$
SELECT jsonb_build_object(
  'entryRef',entry.entry_ref,'entryVersion',entry.version::TEXT,
  'category',entry.category,
  'state',CASE WHEN entry.state='active' THEN 'active' ELSE 'revoked_purge_pending' END,
  'prioritized',entry.prioritized,'revision',entry.current_revision::TEXT,
  'currentRevisionRef',entry.current_revision_ref,'reason',revision.reason,
  'validFrom',revision.valid_from,'validTo',revision.valid_to,
  'createdAt',entry.created_at,'updatedAt',entry.updated_at,
  'protectedContent',CASE WHEN payload.revision_ref IS NULL THEN NULL ELSE jsonb_build_object(
    'envelopeVersion',payload.envelope_version,'keyRevision',payload.protection_key_revision,
    'nonce',encode(payload.nonce,'base64'),'ciphertext',encode(payload.protected_ciphertext,'base64'),
    'authenticationTag',encode(payload.authentication_tag,'base64'),'aadDigest',payload.aad_digest) END,
  'sourceKind',CASE WHEN provenance.source_kind='authenticated_user_command' THEN 'explicit' ELSE 'import' END,
  'sourceState','current','safeSourceLabel',
    CASE WHEN provenance.source_kind='authenticated_user_command' THEN 'Saved by you' ELSE 'Imported memory' END)
FROM platform.memory_entry entry
JOIN platform.memory_space space ON space.site_ref=entry.site_ref
 AND space.space_ref=entry.space_ref
JOIN platform.memory_revision revision ON revision.site_ref=entry.site_ref
 AND revision.space_ref=entry.space_ref AND revision.entry_ref=entry.entry_ref
 AND revision.revision=entry.current_revision AND revision.revision_ref=entry.current_revision_ref
LEFT JOIN platform.memory_revision_payload payload ON payload.site_ref=revision.site_ref
 AND payload.space_ref=revision.space_ref AND payload.entry_ref=revision.entry_ref
 AND payload.revision=revision.revision AND payload.revision_ref=revision.revision_ref
LEFT JOIN LATERAL (SELECT source_kind FROM platform.memory_provenance provenance_row
  WHERE provenance_row.site_ref=revision.site_ref AND provenance_row.space_ref=revision.space_ref
    AND provenance_row.entry_ref=revision.entry_ref AND provenance_row.revision=revision.revision
  ORDER BY provenance_row.provenance_ref LIMIT 1) provenance ON true
WHERE entry.site_ref=p_site_ref AND entry.space_ref=p_space_ref AND entry.entry_ref=p_entry_ref
 AND entry.state='active' AND space.state='active'
 AND entry.feature_policy_revision_ref=space.feature_policy_revision_ref
 AND entry.space_generation=space.space_generation
 AND entry.learning_generation=space.learning_generation
 AND entry.revocation_epoch<=space.revocation_epoch
$$;
REVOKE ALL ON FUNCTION platform.memory_public_entry_json(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_revision_json(
  p_site_ref TEXT,p_space_ref TEXT,p_entry_ref TEXT,p_revision BIGINT
) RETURNS JSONB LANGUAGE sql STABLE SET search_path=pg_catalog,platform AS $$
SELECT jsonb_build_object('revision',revision.revision::TEXT,'revisionRef',revision.revision_ref,
  'reason',revision.reason,'supersedesRevisionRef',revision.supersedes_revision_ref,
  'restoredFromRevisionRef',revision.restored_from_revision_ref,
  'validFrom',revision.valid_from,'validTo',revision.valid_to,'recordedAt',revision.recorded_at,
  'protectedContent',CASE WHEN payload.revision_ref IS NULL THEN NULL ELSE jsonb_build_object(
    'envelopeVersion',payload.envelope_version,'keyRevision',payload.protection_key_revision,
    'nonce',encode(payload.nonce,'base64'),'ciphertext',encode(payload.protected_ciphertext,'base64'),
    'authenticationTag',encode(payload.authentication_tag,'base64'),'aadDigest',payload.aad_digest) END)
FROM platform.memory_revision revision
JOIN platform.memory_entry entry ON entry.site_ref=revision.site_ref
 AND entry.space_ref=revision.space_ref AND entry.entry_ref=revision.entry_ref
JOIN platform.memory_space space ON space.site_ref=entry.site_ref
 AND space.space_ref=entry.space_ref
LEFT JOIN platform.memory_revision_payload payload ON payload.site_ref=revision.site_ref
 AND payload.space_ref=revision.space_ref AND payload.entry_ref=revision.entry_ref
 AND payload.revision=revision.revision AND payload.revision_ref=revision.revision_ref
WHERE revision.site_ref=p_site_ref AND revision.space_ref=p_space_ref
 AND revision.entry_ref=p_entry_ref AND revision.revision=p_revision
 AND entry.state='active' AND space.state='active'
 AND entry.feature_policy_revision_ref=space.feature_policy_revision_ref
 AND entry.space_generation=space.space_generation
 AND entry.learning_generation=space.learning_generation
 AND entry.revocation_epoch<=space.revocation_epoch
$$;
REVOKE ALL ON FUNCTION platform.memory_public_revision_json(TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC;

CREATE FUNCTION platform.memory_public_commit_extension_internal(
  p_operation TEXT,p_payload JSONB
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  v_command JSONB:=p_payload->'command'; v_context JSONB:=v_command->'context';
  v_protected JSONB:=v_command->'protectedContent';
  v_site_ref TEXT:=v_context->>'siteRef'; v_subject_ref TEXT:=v_context->>'subjectRef';
  v_subject_generation BIGINT:=(v_context->>'subjectGeneration')::BIGINT;
  v_policy TEXT:=v_context->>'featurePolicyRevisionRef';
  v_command_ref TEXT:=v_command->>'commandRef'; v_digest CHAR(64):=v_command->>'requestDigest';
  v_digest_key_revision TEXT:=v_command->>'requestDigestKeyRevision';
  v_space_ref TEXT:=v_command->>'spaceRef'; v_entry_ref TEXT:=v_command->>'entryRef';
  v_revision_ref TEXT:=v_command->>'revisionRef'; v_provenance_ref TEXT:=v_command->>'provenanceRef';
  v_prepare_ref TEXT:=p_payload->>'prepareRef';
  v_expected_state_digest CHAR(64):=p_payload->>'expectedStateDigest';
  v_space platform.memory_space%ROWTYPE; v_entry platform.memory_entry%ROWTYPE;
  v_space_state JSONB; v_entry_state JSONB; v_live_digest CHAR(64);
  v_now TIMESTAMPTZ:=statement_timestamp(); v_receipt_kind TEXT; v_safe_kind TEXT;
  v_result_entry_version BIGINT; v_result_revision BIGINT; v_committed BIGINT;
  v_changed BOOLEAN:=true; v_target_revision BIGINT;
BEGIN
  IF p_operation NOT IN ('restore','prioritize','deprioritize')
    OR v_command->>'operation'<>p_operation OR jsonb_typeof(v_context)<>'object' THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_INVALID';
  END IF;
  PERFORM platform.memory_public_personal_owner_internal(v_site_ref,v_subject_ref,
    v_subject_generation,v_policy,v_space_ref);
  PERFORM 1 FROM platform.memory_public_command_inbox inbox
   WHERE inbox.site_ref=v_site_ref AND inbox.command_ref=v_command_ref
     AND inbox.owner_scope_kind='user' AND inbox.owner_subject_ref=v_subject_ref
     AND inbox.owner_subject_generation=v_subject_generation AND inbox.owner_project_ref IS NULL
     AND inbox.operation=p_operation AND inbox.request_digest=v_digest
     AND inbox.request_digest_key_revision=v_digest_key_revision AND inbox.state='accepted'
     AND inbox.prepare_ref=v_prepare_ref AND inbox.expected_state_digest=v_expected_state_digest
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_FENCE_INVALID'; END IF;
  SELECT * INTO v_space FROM platform.memory_space space
   WHERE space.site_ref=v_site_ref AND space.space_ref=v_space_ref FOR UPDATE;
  SELECT * INTO v_entry FROM platform.memory_entry entry
   WHERE entry.site_ref=v_site_ref AND entry.space_ref=v_space_ref
     AND entry.entry_ref=v_entry_ref FOR UPDATE;
  IF v_space.space_ref IS NULL OR v_entry.entry_ref IS NULL OR v_space.state<>'active'
    OR v_entry.state<>'active' OR v_entry.feature_policy_revision_ref<>v_space.feature_policy_revision_ref
    OR v_entry.space_generation<>v_space.space_generation
    OR v_entry.learning_generation<>v_space.learning_generation
    OR v_entry.revocation_epoch>v_space.revocation_epoch THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_NOT_AVAILABLE';
  END IF;
  v_space_state:=platform.memory_public_space_state_internal(v_site_ref,v_space_ref);
  v_entry_state:=platform.memory_public_entry_state_internal(v_site_ref,v_space_ref,v_entry_ref);
  v_live_digest:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,
    'space',v_space_state,'entry',v_entry_state)::TEXT,'UTF8')),'hex');
  IF v_live_digest<>v_expected_state_digest THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;

  IF p_operation='restore' THEN
    IF v_revision_ref IS NULL OR v_provenance_ref IS NULL OR v_protected IS NULL
      OR (v_command->>'expectedRevision')::BIGINT<>v_entry.current_revision
      OR v_entry.current_revision>=2147483647 THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT';
    END IF;
    SELECT revision.revision INTO v_target_revision FROM platform.memory_revision revision
      JOIN platform.memory_revision_payload payload ON payload.site_ref=revision.site_ref
        AND payload.space_ref=revision.space_ref AND payload.entry_ref=revision.entry_ref
        AND payload.revision=revision.revision AND payload.revision_ref=revision.revision_ref
     WHERE revision.site_ref=v_site_ref AND revision.space_ref=v_space_ref
       AND revision.entry_ref=v_entry_ref
       AND revision.revision_ref=v_command->>'restoredFromRevisionRef'
       AND revision.revision<v_entry.current_revision;
    IF v_target_revision IS NULL THEN RAISE EXCEPTION 'MEMORY_PUBLIC_NOT_RESTORABLE'; END IF;
    UPDATE platform.memory_space SET version=version+1,updated_at=v_now
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref RETURNING version INTO v_committed;
    v_result_revision:=v_entry.current_revision+1;
    INSERT INTO platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref,reason,
      supersedes_revision,supersedes_revision_ref,restored_from_revision_ref,
      feature_policy_revision_ref,valid_from,valid_to,recorded_at)
    VALUES (v_site_ref,v_space_ref,v_entry_ref,v_result_revision,v_revision_ref,'restored',
      v_entry.current_revision,v_entry.current_revision_ref,v_command->>'restoredFromRevisionRef',
      v_policy,(v_command->>'validFrom')::TIMESTAMPTZ,
      (v_command->>'validTo')::TIMESTAMPTZ,v_now);
    INSERT INTO platform.memory_revision_payload(site_ref,space_ref,entry_ref,revision,revision_ref,
      envelope_version,protection_key_revision,nonce,protected_ciphertext,authentication_tag,
      aad_digest,protected_at)
    VALUES (v_site_ref,v_space_ref,v_entry_ref,v_result_revision,v_revision_ref,
      (v_protected->>'envelopeVersion')::SMALLINT,v_protected->>'keyRevision',
      decode(v_protected->>'nonce','base64'),decode(v_protected->>'ciphertext','base64'),
      decode(v_protected->>'authenticationTag','base64'),v_protected->>'aadDigest',v_now);
    INSERT INTO platform.memory_provenance(site_ref,space_ref,entry_ref,revision,revision_ref,
      provenance_ref,source_kind,source_ref,source_digest,source_digest_key_revision,
      actor_subject_ref,actor_subject_generation,actor_project_ref,actor_membership_epoch,
      actor_authorization_epoch,recorded_at)
    VALUES (v_site_ref,v_space_ref,v_entry_ref,v_result_revision,v_revision_ref,v_provenance_ref,
      'authenticated_user_command',v_command_ref,v_digest,v_digest_key_revision,
      v_subject_ref,v_subject_generation,NULL,NULL,NULL,v_now);
    UPDATE platform.memory_entry SET version=version+1,current_revision=v_result_revision,
      current_revision_ref=v_revision_ref,updated_at=v_now
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref AND entry_ref=v_entry_ref
     RETURNING version INTO v_result_entry_version;
    v_receipt_kind:='restored'; v_safe_kind:='restored';
  ELSE
    IF (v_command->>'expectedEntryVersion')::BIGINT<>v_entry.version
      OR (v_command->>'prioritized')::BOOLEAN<>(p_operation='prioritize') THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT';
    END IF;
    IF v_entry.prioritized=(p_operation='prioritize') THEN
      v_changed:=false; v_committed:=v_space.version; v_result_entry_version:=v_entry.version;
    ELSE
      UPDATE platform.memory_space SET version=version+1,updated_at=v_now
       WHERE site_ref=v_site_ref AND space_ref=v_space_ref RETURNING version INTO v_committed;
      UPDATE platform.memory_entry SET version=version+1,prioritized=(p_operation='prioritize'),
        updated_at=v_now WHERE site_ref=v_site_ref AND space_ref=v_space_ref AND entry_ref=v_entry_ref
        RETURNING version INTO v_result_entry_version;
    END IF;
    v_receipt_kind:=CASE WHEN p_operation='prioritize' THEN 'prioritized' ELSE 'deprioritized' END;
    v_safe_kind:='entry';
  END IF;

  INSERT INTO platform.memory_command_receipt(site_ref,owner_scope_kind,owner_subject_ref,
    owner_subject_generation,owner_project_ref,caller_subject_ref,caller_subject_generation,
    caller_membership_epoch,caller_authorization_epoch,command_ref,operation,request_digest,
    request_digest_key_revision,result_kind,result_space_ref,result_space_version,result_entry_ref,
    result_entry_version,result_revision_ref,result_revision,result_space_generation,
    result_learning_generation,result_revocation_epoch,result_minimum_source_origin_seq,
    result_learning_state,result_use_state,result_previous_feature_policy_revision_ref,
    result_feature_policy_revision_ref,recorded_at)
  VALUES (v_site_ref,'user',v_subject_ref,v_subject_generation,NULL,v_subject_ref,
    v_subject_generation,NULL,NULL,v_command_ref,p_operation,v_digest,v_digest_key_revision,
    v_receipt_kind,v_space_ref,v_committed,v_entry_ref,v_result_entry_version,
    CASE WHEN p_operation='restore' THEN v_revision_ref ELSE NULL END,v_result_revision,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,v_now);
  UPDATE platform.memory_public_command_inbox SET state='completed',safe_result_kind=v_safe_kind,
    result_ref=v_entry_ref,committed_space_version=v_committed,result_entry_ref=v_entry_ref,
    result_entry_version=v_result_entry_version,result_revision=v_result_revision,
    result_revision_ref=CASE WHEN p_operation='restore' THEN v_revision_ref ELSE NULL END,
    completed_at=v_now
   WHERE site_ref=v_site_ref AND command_ref=v_command_ref;
  RETURN jsonb_build_object('decision','committed','kind',v_safe_kind,
    'committedSpaceVersion',v_committed::TEXT,'entryRef',v_entry_ref,
    'entryVersion',v_result_entry_version::TEXT,'revision',v_result_revision::TEXT,
    'revisionRef',CASE WHEN p_operation='restore' THEN v_revision_ref ELSE NULL END,
    'restoredFromRevisionRef',CASE WHEN p_operation='restore'
      THEN v_command->>'restoredFromRevisionRef' ELSE NULL END,
    'prioritized',CASE WHEN p_operation IN ('prioritize','deprioritize')
      THEN p_operation='prioritize' ELSE NULL END,'changed',v_changed);
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_commit_extension_internal(TEXT,JSONB) FROM PUBLIC;

-- Core public mutations are computed by MemoryAuthorityService. This routine performs only
-- prepare-receipt binding, current-state digest CAS, and persistence of that validated transition.
CREATE FUNCTION platform.memory_public_commit_validated_core_internal(
  p_operation TEXT,p_payload JSONB
) RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  v_command JSONB:=p_payload->'command'; v_transition JSONB:=p_payload->'transition';
  v_context JSONB:=v_command->'context'; v_site_ref TEXT:=v_context->>'siteRef';
  v_subject_ref TEXT:=v_context->>'subjectRef';
  v_subject_generation BIGINT:=(v_context->>'subjectGeneration')::BIGINT;
  v_policy TEXT:=v_context->>'featurePolicyRevisionRef';
  v_space_ref TEXT:=v_command->>'spaceRef'; v_entry_ref TEXT:=v_command->>'entryRef';
  v_command_ref TEXT:=v_command->>'commandRef'; v_digest CHAR(64):=v_command->>'requestDigest';
  v_digest_key_revision TEXT:=v_command->>'requestDigestKeyRevision';
  v_prepare_ref TEXT:=p_payload->>'prepareRef';
  v_expected_state_digest CHAR(64):=p_payload->>'expectedStateDigest';
  v_space_state JSONB; v_entry_state JSONB; v_live_digest CHAR(64);
  v_remembered JSONB; v_entry JSONB; v_revision JSONB; v_provenance JSONB; v_protected JSONB;
  v_result JSONB:=v_transition->'result'; v_committed BIGINT;
  v_safe_kind TEXT; v_receipt_kind TEXT; v_updated BIGINT;
BEGIN
  IF p_operation NOT IN ('remember','correct','forget','reset')
    OR v_command->>'operation' IS DISTINCT FROM p_operation
    OR v_transition->>'operation' IS DISTINCT FROM p_operation
    OR jsonb_typeof(v_context) IS DISTINCT FROM 'object'
    OR jsonb_typeof(v_transition) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_INVALID';
  END IF;
  PERFORM platform.memory_public_personal_owner_internal(v_site_ref,v_subject_ref,
    v_subject_generation,v_policy,v_space_ref);
  PERFORM 1 FROM platform.memory_public_command_inbox inbox
   WHERE inbox.site_ref=v_site_ref AND inbox.command_ref=v_command_ref
     AND inbox.owner_scope_kind='user' AND inbox.owner_subject_ref=v_subject_ref
     AND inbox.owner_subject_generation=v_subject_generation AND inbox.owner_project_ref IS NULL
     AND inbox.operation=p_operation AND inbox.request_digest=v_digest
     AND inbox.request_digest_key_revision=v_digest_key_revision AND inbox.state='accepted'
     AND inbox.prepare_ref=v_prepare_ref
     AND inbox.expected_state_digest=v_expected_state_digest FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_FENCE_INVALID'; END IF;

  v_space_state:=platform.memory_public_space_state_internal(v_site_ref,v_space_ref);
  v_entry_state:=CASE WHEN p_operation IN ('correct','forget')
    THEN platform.memory_public_entry_state_internal(v_site_ref,v_space_ref,v_entry_ref) ELSE NULL END;
  v_live_digest:=encode(sha256(convert_to(jsonb_build_object('operation',p_operation,
    'space',v_space_state,'entry',v_entry_state)::TEXT,'UTF8')),'hex');
  IF v_live_digest<>v_expected_state_digest THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT';
  END IF;
  v_committed:=(v_transition->>'committedSpaceVersion')::BIGINT;
  IF v_committed IS NULL OR v_committed<=0 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_COMMAND_INVALID'; END IF;

  -- Treat the application-computed transition as an untrusted persistence proposal.  The
  -- prepare receipt authenticates the command/current state; these bindings prevent a caller
  -- with the dedicated public credential from swapping identities, policy, protected bytes, or
  -- result references between the validated command and the rows persisted below.
  IF p_operation IN ('remember','correct') THEN
    v_remembered:=CASE WHEN p_operation='remember' THEN v_transition->'remembered'
      ELSE v_transition->'corrected' END;
    v_entry:=v_remembered->'entry'; v_revision:=v_remembered->'revision';
    v_provenance:=v_remembered->'provenance'; v_protected:=v_revision->'protectedContent';
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_revision) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_provenance) IS DISTINCT FROM 'object'
      OR jsonb_typeof(v_protected) IS DISTINCT FROM 'object'
      OR v_entry->>'siteRef' IS DISTINCT FROM v_site_ref
      OR v_entry->>'spaceRef' IS DISTINCT FROM v_space_ref
      OR v_entry->>'entryRef' IS DISTINCT FROM v_entry_ref
      OR v_entry->>'currentRevisionRef' IS DISTINCT FROM v_command->>'revisionRef'
      OR v_entry->>'featurePolicyRevisionRef' IS DISTINCT FROM v_policy
      OR v_revision->>'siteRef' IS DISTINCT FROM v_site_ref
      OR v_revision->>'spaceRef' IS DISTINCT FROM v_space_ref
      OR v_revision->>'entryRef' IS DISTINCT FROM v_entry_ref
      OR v_revision->>'revisionRef' IS DISTINCT FROM v_command->>'revisionRef'
      OR v_revision->>'featurePolicyRevisionRef' IS DISTINCT FROM v_policy
      OR v_revision->>'recordedAt' IS DISTINCT FROM v_command->>'recordedAt'
      OR v_provenance->>'siteRef' IS DISTINCT FROM v_site_ref
      OR v_provenance->>'spaceRef' IS DISTINCT FROM v_space_ref
      OR v_provenance->>'entryRef' IS DISTINCT FROM v_entry_ref
      OR v_provenance->>'revisionRef' IS DISTINCT FROM v_command->>'revisionRef'
      OR v_provenance->>'provenanceRef' IS DISTINCT FROM v_command->>'provenanceRef'
      OR v_provenance->>'sourceRef' IS DISTINCT FROM v_command_ref
      OR v_provenance->>'actorSubjectRef' IS DISTINCT FROM v_subject_ref
      OR (v_provenance->>'actorSubjectGeneration')::BIGINT IS DISTINCT FROM v_subject_generation
      OR v_provenance->>'recordedAt' IS DISTINCT FROM v_command->>'recordedAt'
      OR v_protected IS DISTINCT FROM v_command->'protectedContent'
      OR v_result->>'entryRef' IS DISTINCT FROM v_entry_ref
      OR v_result->>'revisionRef' IS DISTINCT FROM v_command->>'revisionRef' THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_TRANSITION_INVALID';
    END IF;
  ELSIF p_operation='forget' THEN
    v_entry:=v_transition->'entry';
    IF jsonb_typeof(v_entry) IS DISTINCT FROM 'object'
      OR v_entry->>'siteRef' IS DISTINCT FROM v_site_ref
      OR v_entry->>'spaceRef' IS DISTINCT FROM v_space_ref
      OR v_entry->>'entryRef' IS DISTINCT FROM v_entry_ref
      OR v_result->>'entryRef' IS DISTINCT FROM v_entry_ref THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_TRANSITION_INVALID';
    END IF;
  END IF;
  IF p_operation IN ('forget','reset') THEN
    IF v_transition->'space'->>'spaceRef' IS DISTINCT FROM v_space_ref
      OR v_transition->'space'->'binding'->>'siteRef' IS DISTINCT FROM v_site_ref
      OR v_transition->'space'->'binding'->>'subjectRef' IS DISTINCT FROM v_subject_ref
      OR (v_transition->'space'->'binding'->>'subjectGeneration')::BIGINT
        IS DISTINCT FROM v_subject_generation
      OR v_transition->'space'->>'featurePolicyRevisionRef' IS DISTINCT FROM v_policy
      OR (v_transition->'space'->>'version')::BIGINT IS DISTINCT FROM v_committed THEN
      RAISE EXCEPTION 'MEMORY_PUBLIC_TRANSITION_INVALID';
    END IF;
  END IF;

  IF p_operation='remember' THEN
    v_remembered:=v_transition->'remembered'; v_entry:=v_remembered->'entry';
    v_revision:=v_remembered->'revision'; v_provenance:=v_remembered->'provenance';
    v_protected:=v_revision->'protectedContent';
    IF v_transition->'newSpace' IS NOT NULL AND v_transition->'newSpace'<>'null'::JSONB THEN
      INSERT INTO platform.memory_space(site_ref,space_ref,scope_kind,parent_space_ref,
        parent_space_generation,parent_learning_generation,parent_revocation_epoch,
        subject_ref,subject_generation,project_ref,agent_option_ref,product_surface_ref,
        feature_policy_revision_ref,version,space_generation,learning_generation,revocation_epoch,
        minimum_learnable_source_origin_seq,learning_state,use_state,state,created_at,updated_at)
      SELECT v_site_ref,space->>'spaceRef','user',NULL,NULL,NULL,NULL,v_subject_ref,
        v_subject_generation,NULL,NULL,NULL,space->>'featurePolicyRevisionRef',
        (space->>'version')::BIGINT,(space->>'spaceGeneration')::BIGINT,
        (space->>'learningGeneration')::BIGINT,(space->>'revocationEpoch')::BIGINT,
        (space->>'minimumLearnableSourceOriginSequence')::BIGINT,space->>'learningState',
        space->>'useState',space->>'state',(space->>'createdAt')::TIMESTAMPTZ,
        (space->>'updatedAt')::TIMESTAMPTZ FROM (SELECT v_transition->'newSpace' AS space) value;
    ELSE
      UPDATE platform.memory_space SET version=v_committed,
        updated_at=(v_entry->>'updatedAt')::TIMESTAMPTZ
       WHERE site_ref=v_site_ref AND space_ref=v_space_ref
         AND version=(v_space_state->>'version')::BIGINT;
      GET DIAGNOSTICS v_updated=ROW_COUNT;
      IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
    END IF;
    INSERT INTO platform.memory_entry(site_ref,space_ref,entry_ref,version,current_revision,
      current_revision_ref,state,category,feature_policy_revision_ref,space_generation,
      learning_generation,revocation_epoch,prioritized,created_at,updated_at,deleted_at)
    VALUES (v_entry->>'siteRef',v_entry->>'spaceRef',v_entry->>'entryRef',
      (v_entry->>'version')::BIGINT,(v_entry->>'currentRevision')::BIGINT,
      v_entry->>'currentRevisionRef',v_entry->>'state',v_entry->>'category',
      v_entry->>'featurePolicyRevisionRef',(v_entry->>'spaceGeneration')::BIGINT,
      (v_entry->>'learningGeneration')::BIGINT,(v_entry->>'revocationEpoch')::BIGINT,false,
      (v_entry->>'createdAt')::TIMESTAMPTZ,(v_entry->>'updatedAt')::TIMESTAMPTZ,NULL);
  ELSIF p_operation='correct' THEN
    v_remembered:=v_transition->'corrected'; v_entry:=v_remembered->'entry';
    v_revision:=v_remembered->'revision'; v_provenance:=v_remembered->'provenance';
    v_protected:=v_revision->'protectedContent';
    UPDATE platform.memory_space SET version=v_committed,
      updated_at=(v_entry->>'updatedAt')::TIMESTAMPTZ
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref
       AND version=(v_space_state->>'version')::BIGINT;
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
  ELSIF p_operation='forget' THEN
    v_entry:=v_transition->'entry';
    UPDATE platform.memory_space SET version=(v_transition->'space'->>'version')::BIGINT,
      space_generation=(v_transition->'space'->>'spaceGeneration')::BIGINT,
      learning_generation=(v_transition->'space'->>'learningGeneration')::BIGINT,
      revocation_epoch=(v_transition->'space'->>'revocationEpoch')::BIGINT,
      minimum_learnable_source_origin_seq=
        (v_transition->'space'->>'minimumLearnableSourceOriginSequence')::BIGINT,
      learning_state=v_transition->'space'->>'learningState',
      use_state=v_transition->'space'->>'useState',state=v_transition->'space'->>'state',
      updated_at=(v_transition->'space'->>'updatedAt')::TIMESTAMPTZ
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref
       AND version=(v_transition->'expected'->>'spaceVersion')::BIGINT;
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
    UPDATE platform.memory_entry SET version=(v_entry->>'version')::BIGINT,
      state=v_entry->>'state',revocation_epoch=(v_entry->>'revocationEpoch')::BIGINT,
      updated_at=(v_entry->>'updatedAt')::TIMESTAMPTZ,
      deleted_at=(v_entry->>'deletedAt')::TIMESTAMPTZ
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref AND entry_ref=v_entry_ref
       AND version=(v_transition->'expected'->>'entryVersion')::BIGINT;
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
  ELSE
    UPDATE platform.memory_space SET version=(v_transition->'space'->>'version')::BIGINT,
      space_generation=(v_transition->'space'->>'spaceGeneration')::BIGINT,
      learning_generation=(v_transition->'space'->>'learningGeneration')::BIGINT,
      revocation_epoch=(v_transition->'space'->>'revocationEpoch')::BIGINT,
      minimum_learnable_source_origin_seq=
        (v_transition->'space'->>'minimumLearnableSourceOriginSequence')::BIGINT,
      learning_state=v_transition->'space'->>'learningState',
      use_state=v_transition->'space'->>'useState',state=v_transition->'space'->>'state',
      updated_at=(v_transition->'space'->>'updatedAt')::TIMESTAMPTZ
     WHERE site_ref=v_site_ref AND space_ref=v_space_ref
       AND version=(v_transition->>'expectedVersion')::BIGINT;
    GET DIAGNOSTICS v_updated=ROW_COUNT;
    IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
  END IF;

  IF p_operation IN ('remember','correct') THEN
    INSERT INTO platform.memory_revision(site_ref,space_ref,entry_ref,revision,revision_ref,reason,
      supersedes_revision,supersedes_revision_ref,restored_from_revision_ref,
      feature_policy_revision_ref,valid_from,valid_to,recorded_at)
    VALUES (v_revision->>'siteRef',v_revision->>'spaceRef',v_revision->>'entryRef',
      (v_revision->>'revision')::BIGINT,v_revision->>'revisionRef',v_revision->>'reason',
      CASE WHEN v_revision->>'supersedesRevisionRef' IS NULL THEN NULL
        ELSE (v_revision->>'revision')::BIGINT-1 END,v_revision->>'supersedesRevisionRef',NULL,
      v_revision->>'featurePolicyRevisionRef',(v_command->>'validFrom')::TIMESTAMPTZ,
      (v_command->>'validTo')::TIMESTAMPTZ,
      (v_revision->>'recordedAt')::TIMESTAMPTZ);
    INSERT INTO platform.memory_revision_payload(site_ref,space_ref,entry_ref,revision,revision_ref,
      envelope_version,protection_key_revision,nonce,protected_ciphertext,authentication_tag,
      aad_digest,protected_at)
    VALUES (v_revision->>'siteRef',v_revision->>'spaceRef',v_revision->>'entryRef',
      (v_revision->>'revision')::BIGINT,v_revision->>'revisionRef',
      (v_protected->>'envelopeVersion')::SMALLINT,v_protected->>'keyRevision',
      decode(v_protected->>'nonce','base64'),decode(v_protected->>'ciphertext','base64'),
      decode(v_protected->>'authenticationTag','base64'),v_protected->>'aadDigest',
      (v_revision->>'recordedAt')::TIMESTAMPTZ);
    INSERT INTO platform.memory_provenance(site_ref,space_ref,entry_ref,revision,revision_ref,
      provenance_ref,source_kind,source_ref,source_digest,source_digest_key_revision,
      actor_subject_ref,actor_subject_generation,actor_project_ref,actor_membership_epoch,
      actor_authorization_epoch,recorded_at)
    VALUES (v_provenance->>'siteRef',v_provenance->>'spaceRef',v_provenance->>'entryRef',
      (v_revision->>'revision')::BIGINT,v_provenance->>'revisionRef',
      v_provenance->>'provenanceRef',v_provenance->>'sourceKind',v_provenance->>'sourceRef',
      v_digest,v_digest_key_revision,v_provenance->>'actorSubjectRef',
      (v_provenance->>'actorSubjectGeneration')::BIGINT,NULL,NULL,NULL,
      (v_provenance->>'recordedAt')::TIMESTAMPTZ);
    IF p_operation='correct' THEN
      UPDATE platform.memory_entry SET version=(v_entry->>'version')::BIGINT,
        current_revision=(v_entry->>'currentRevision')::BIGINT,
        current_revision_ref=v_entry->>'currentRevisionRef',
        updated_at=(v_entry->>'updatedAt')::TIMESTAMPTZ
       WHERE site_ref=v_site_ref AND space_ref=v_space_ref AND entry_ref=v_entry_ref
         AND version=(v_transition->'expected'->>'entryVersion')::BIGINT
         AND current_revision=(v_transition->'expected'->>'currentRevision')::BIGINT;
      GET DIAGNOSTICS v_updated=ROW_COUNT;
      IF v_updated<>1 THEN RAISE EXCEPTION 'MEMORY_PUBLIC_VERSION_CONFLICT'; END IF;
    END IF;
  END IF;

  v_receipt_kind:=v_result->>'kind';
  v_safe_kind:=CASE WHEN p_operation IN ('forget','reset') THEN 'purge' ELSE 'entry' END;
  INSERT INTO platform.memory_command_receipt(site_ref,owner_scope_kind,owner_subject_ref,
    owner_subject_generation,owner_project_ref,caller_subject_ref,caller_subject_generation,
    caller_membership_epoch,caller_authorization_epoch,command_ref,operation,request_digest,
    request_digest_key_revision,result_kind,result_space_ref,result_space_version,result_entry_ref,
    result_entry_version,result_revision_ref,result_revision,result_space_generation,
    result_learning_generation,result_revocation_epoch,result_minimum_source_origin_seq,
    result_learning_state,result_use_state,result_previous_feature_policy_revision_ref,
    result_feature_policy_revision_ref,recorded_at)
  VALUES (v_site_ref,'user',v_subject_ref,v_subject_generation,NULL,v_subject_ref,
    v_subject_generation,NULL,NULL,v_command_ref,p_operation,v_digest,v_digest_key_revision,
    v_receipt_kind,v_space_ref,v_committed,v_result->>'entryRef',
    (v_result->>'entryVersion')::BIGINT,v_result->>'revisionRef',
    (v_result->>'revision')::BIGINT,(v_result->>'spaceGeneration')::BIGINT,
    (v_result->>'learningGeneration')::BIGINT,(v_result->>'revocationEpoch')::BIGINT,
    (v_result->>'minimumLearnableSourceOriginSequence')::BIGINT,v_result->>'learningState',
    v_result->>'useState',NULL,NULL,statement_timestamp());
  UPDATE platform.memory_public_command_inbox SET state='completed',safe_result_kind=v_safe_kind,
    result_ref=COALESCE(v_result->>'entryRef',v_space_ref),committed_space_version=v_committed,
    result_entry_ref=v_result->>'entryRef',result_entry_version=(v_result->>'entryVersion')::BIGINT,
    result_revision=(v_result->>'revision')::BIGINT,result_revision_ref=v_result->>'revisionRef',
    completed_at=statement_timestamp()
   WHERE site_ref=v_site_ref AND command_ref=v_command_ref;
  RETURN jsonb_build_object('decision','committed','kind',v_safe_kind,
    'committedSpaceVersion',v_committed::TEXT,'entryRef',v_result->>'entryRef',
    'entryVersion',v_result->>'entryVersion','revision',v_result->>'revision',
    'revisionRef',v_result->>'revisionRef');
END $$;
REVOKE ALL ON FUNCTION platform.memory_public_commit_validated_core_internal(TEXT,JSONB) FROM PUBLIC;

-- Public read owner wrappers are intentionally separate so no generic authorization oracle is callable.
CREATE FUNCTION platform.memory_public_list_entries_owner(TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5); END $$;
CREATE FUNCTION platform.memory_public_get_entry_owner(TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5); END $$;
CREATE FUNCTION platform.memory_public_list_entry_history_owner(TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5); END $$;
CREATE FUNCTION platform.memory_public_restore_owner(TEXT,TEXT,BIGINT,TEXT,TEXT,TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5); END $$;

CREATE FUNCTION platform.memory_public_list_entries(
  TEXT,TEXT,BIGINT,TEXT,TEXT,BIGINT,TEXT,TEXT,BOOLEAN,TIMESTAMPTZ,TEXT,INTEGER
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owner_result JSONB; result JSONB;
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  owner_result:=platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5);
  IF (owner_result->>'spaceVersion')::BIGINT<>$6 OR $12 NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_OWNER_SNAPSHOT_STALE';
  END IF;
  IF NOT (owner_result->>'persisted')::BOOLEAN THEN RETURN '[]'::JSONB; END IF;
  SELECT COALESCE(jsonb_agg(platform.memory_public_entry_json(entry.site_ref,entry.space_ref,
    entry.entry_ref) ORDER BY entry.prioritized DESC,entry.updated_at DESC,entry.entry_ref DESC),'[]')
    INTO result FROM (SELECT candidate.* FROM platform.memory_entry candidate
      JOIN platform.memory_space space ON space.site_ref=candidate.site_ref
        AND space.space_ref=candidate.space_ref
     WHERE candidate.site_ref=$1 AND candidate.space_ref=$5 AND candidate.state='active'
       AND candidate.space_generation=space.space_generation
       AND candidate.learning_generation=space.learning_generation
       AND candidate.revocation_epoch<=space.revocation_epoch
       AND ($7 IS NULL OR candidate.category=$7)
       AND ($8 IS NULL OR $8='explicit')
       AND ($9 IS NULL OR (candidate.prioritized,candidate.updated_at,candidate.entry_ref)<
         ($9,$10,$11))
     ORDER BY candidate.prioritized DESC,candidate.updated_at DESC,candidate.entry_ref DESC
     LIMIT $12) entry;
  RETURN result;
END $$;

CREATE FUNCTION platform.memory_public_get_entry(TEXT,TEXT,BIGINT,TEXT,TEXT,BIGINT,TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owner_result JSONB;
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  owner_result:=platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5);
  IF (owner_result->>'spaceVersion')::BIGINT<>$6 THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_OWNER_SNAPSHOT_STALE';
  END IF;
  RETURN platform.memory_public_entry_json($1,$5,$7);
END $$;

CREATE FUNCTION platform.memory_public_list_entry_history(
  TEXT,TEXT,BIGINT,TEXT,TEXT,BIGINT,TEXT,BIGINT,INTEGER
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owner_result JSONB; entry_result JSONB; revisions_result JSONB;
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  owner_result:=platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5);
  IF (owner_result->>'spaceVersion')::BIGINT<>$6 OR $9 NOT BETWEEN 1 AND 101 THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_OWNER_SNAPSHOT_STALE';
  END IF;
  entry_result:=platform.memory_public_entry_json($1,$5,$7);
  IF entry_result IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_agg(platform.memory_public_revision_json(revision.site_ref,
    revision.space_ref,revision.entry_ref,revision.revision) ORDER BY revision.revision DESC),'[]')
    INTO revisions_result FROM (SELECT candidate.* FROM platform.memory_revision candidate
      WHERE candidate.site_ref=$1 AND candidate.space_ref=$5 AND candidate.entry_ref=$7
        AND ($8 IS NULL OR candidate.revision<$8)
      ORDER BY candidate.revision DESC LIMIT $9) revision;
  RETURN jsonb_build_object('entry',entry_result,'revisions',revisions_result);
END $$;

CREATE FUNCTION platform.memory_public_get_restorable_revision(
  TEXT,TEXT,BIGINT,TEXT,TEXT,BIGINT,TEXT,TEXT,INTEGER
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE owner_result JSONB; actual_revision BIGINT;
BEGIN
  PERFORM platform.assert_memory_database_role('public');
  owner_result:=platform.memory_public_personal_owner_internal($1,$2,$3,$4,$5);
  IF (owner_result->>'spaceVersion')::BIGINT<>$6 THEN
    RAISE EXCEPTION 'MEMORY_PUBLIC_OWNER_SNAPSHOT_STALE';
  END IF;
  SELECT revision.revision INTO actual_revision FROM platform.memory_revision revision
    JOIN platform.memory_entry entry ON entry.site_ref=revision.site_ref
      AND entry.space_ref=revision.space_ref AND entry.entry_ref=revision.entry_ref
    JOIN platform.memory_space space ON space.site_ref=entry.site_ref
      AND space.space_ref=entry.space_ref
   WHERE revision.site_ref=$1 AND revision.space_ref=$5 AND revision.entry_ref=$7
     AND revision.revision_ref=$8 AND revision.revision<entry.current_revision
     AND entry.current_revision=$9 AND entry.state='active' AND space.state='active'
     AND entry.space_generation=space.space_generation
     AND entry.learning_generation=space.learning_generation
     AND entry.revocation_epoch<=space.revocation_epoch;
  IF actual_revision IS NULL THEN RETURN NULL; END IF;
  RETURN platform.memory_public_revision_json($1,$5,$7,actual_revision);
END $$;

CREATE FUNCTION platform.memory_public_prepare_remember(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'remember',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_correct(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'correct',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_restore(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'restore',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_prioritize(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'prioritize',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_deprioritize(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'deprioritize',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_forget(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'forget',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;
CREATE FUNCTION platform.memory_public_prepare_reset(TEXT,TEXT,BIGINT,TEXT,TEXT,CHAR(64),TEXT,TEXT,TEXT,TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN
PERFORM platform.assert_memory_database_role('public'); RETURN platform.memory_public_prepare_command_internal(
'reset',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10); END $$;

CREATE FUNCTION platform.memory_public_commit_remember(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_validated_core_internal('remember',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_correct(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_validated_core_internal('correct',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_restore(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_extension_internal('restore',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_prioritize(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_extension_internal('prioritize',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_deprioritize(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_extension_internal('deprioritize',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_forget(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_validated_core_internal('forget',$1); END $$;
CREATE FUNCTION platform.memory_public_commit_reset(JSONB) RETURNS JSONB LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,platform AS $$ BEGIN PERFORM platform.assert_memory_database_role('public');
RETURN platform.memory_public_commit_validated_core_internal('reset',$1); END $$;

DO $$ DECLARE signature REGPROCEDURE;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'platform.memory_public_list_entries_owner(text,text,bigint,text,text,timestamptz)'::REGPROCEDURE,
    'platform.memory_public_get_entry_owner(text,text,bigint,text,text,timestamptz)'::REGPROCEDURE,
    'platform.memory_public_list_entry_history_owner(text,text,bigint,text,text,timestamptz)'::REGPROCEDURE,
    'platform.memory_public_restore_owner(text,text,bigint,text,text,timestamptz)'::REGPROCEDURE,
    'platform.memory_public_list_entries(text,text,bigint,text,text,bigint,text,text,boolean,timestamptz,text,integer)'::REGPROCEDURE,
    'platform.memory_public_get_entry(text,text,bigint,text,text,bigint,text)'::REGPROCEDURE,
    'platform.memory_public_list_entry_history(text,text,bigint,text,text,bigint,text,bigint,integer)'::REGPROCEDURE,
    'platform.memory_public_get_restorable_revision(text,text,bigint,text,text,bigint,text,text,integer)'::REGPROCEDURE,
    'platform.memory_public_prepare_remember(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_correct(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_restore(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_prioritize(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_deprioritize(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_forget(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_prepare_reset(text,text,bigint,text,text,character,text,text,text,text)'::REGPROCEDURE,
    'platform.memory_public_commit_remember(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_correct(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_restore(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_prioritize(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_deprioritize(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_forget(jsonb)'::REGPROCEDURE,
    'platform.memory_public_commit_reset(jsonb)'::REGPROCEDURE
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO platform_memory_public',signature);
  END LOOP;
END $$;

-- FORCE RLS remains active. The table owner can enter only while serving the exact
-- public login role through the fixed SECURITY DEFINER routines above.
CREATE POLICY site_memory_public_definer ON platform.site FOR SELECT TO platform_migrator
  USING (SESSION_USER='platform_memory_public');
CREATE POLICY site_release_memory_public_definer ON platform.site_release FOR SELECT
  TO platform_migrator USING (SESSION_USER='platform_memory_public');
CREATE POLICY memory_space_public_definer ON platform.memory_space TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_entry_public_definer ON platform.memory_entry TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_revision_public_definer ON platform.memory_revision TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_revision_payload_public_definer ON platform.memory_revision_payload TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_provenance_public_definer ON platform.memory_provenance TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_command_receipt_public_definer ON platform.memory_command_receipt TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');
CREATE POLICY memory_public_inbox_public_definer ON platform.memory_public_command_inbox TO platform_migrator
  USING (SESSION_USER='platform_memory_public') WITH CHECK (SESSION_USER='platform_memory_public');

GRANT USAGE ON SCHEMA platform TO platform_memory_public;

REVOKE ALL ON TABLE platform.memory_space FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_entry FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_revision FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_revision_payload FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_provenance FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_command_receipt FROM platform_memory_public;
REVOKE ALL ON TABLE platform.memory_public_command_inbox FROM platform_memory_public;
