SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE FUNCTION platform.admission_lease_tombstone_is_valid(
  p_role_names TEXT[],p_role_oids BIGINT[]
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog
AS $function$
  SELECT p_role_names IS NOT NULL AND p_role_oids IS NOT NULL
    AND COALESCE(array_ndims(p_role_names),1)=1
    AND COALESCE(array_ndims(p_role_oids),1)=1
    AND cardinality(p_role_names)=cardinality(p_role_oids)
    AND cardinality(p_role_names) BETWEEN 0 AND 16
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(p_role_names,p_role_oids) retired(role_name,role_oid)
      WHERE retired.role_name IS NULL OR retired.role_oid IS NULL
        OR retired.role_name !~ '^[a-z_][a-z0-9_]{0,62}$'
        OR retired.role_oid<=0
    )
    AND cardinality(p_role_names)=(SELECT count(DISTINCT role_name)
      FROM unnest(p_role_names) role_name)
    AND cardinality(p_role_oids)=(SELECT count(DISTINCT role_oid)
      FROM unnest(p_role_oids) role_oid)
$function$;
REVOKE ALL ON FUNCTION platform.admission_lease_tombstone_is_valid(TEXT[],BIGINT[])
  FROM PUBLIC;

ALTER TABLE platform.runtime_role_identity_authority
  DROP CONSTRAINT runtime_role_identity_authority_role_kind_check;
ALTER TABLE platform.runtime_role_identity_authority
  ADD CONSTRAINT runtime_role_identity_authority_role_kind_check CHECK (role_kind IN (
    'commerce-worker','site-worker','asset-worker','admin-worker',
    'identity-worker','authorization-maintenance',
    'memory_public','memory_runtime','memory_worker','admission'
  ));
ALTER TABLE platform.runtime_role_identity_authority
  ADD COLUMN lease_state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN lease_epoch BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN pending_role_name TEXT,
  ADD COLUMN pending_role_oid BIGINT,
  ADD COLUMN retiring_role_names TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  ADD COLUMN retiring_role_oids BIGINT[] NOT NULL DEFAULT '{}'::BIGINT[],
  ADD COLUMN draining_started_at TIMESTAMPTZ,
  ADD CONSTRAINT runtime_role_identity_authority_lease_state_check
    CHECK (lease_state IN ('active','draining')),
  ADD CONSTRAINT runtime_role_identity_authority_admission_lease_check CHECK (
    lease_epoch>0
    AND platform.admission_lease_tombstone_is_valid(
      retiring_role_names,retiring_role_oids
    )
    AND (
      (role_kind<>'admission'
        AND lease_state='active'
        AND lease_epoch=1
        AND pending_role_name IS NULL
        AND pending_role_oid IS NULL
        AND cardinality(retiring_role_names)=0
        AND draining_started_at IS NULL)
      OR
      (role_kind='admission' AND (
        (lease_state='active'
          AND pending_role_name IS NULL
          AND pending_role_oid IS NULL
          AND cardinality(retiring_role_names)=0
          AND draining_started_at IS NULL)
        OR
        (lease_state='draining'
          AND lease_epoch<9223372036854775807
          AND pending_role_name IS NOT NULL
          AND pending_role_oid IS NOT NULL
          AND pending_role_name ~ '^kt_pg_[a-z0-9_]{1,57}$'
          AND pending_role_oid>0
          AND pending_role_name<>role_name
          AND pending_role_oid<>role_oid
          AND cardinality(retiring_role_names)>0
          AND role_name=ANY(retiring_role_names)
          AND role_oid=retiring_role_oids[array_position(retiring_role_names,role_name)]
          AND NOT pending_role_name=ANY(retiring_role_names)
          AND NOT pending_role_oid=ANY(retiring_role_oids)
          AND draining_started_at IS NOT NULL)
      ))
    )
  );

CREATE FUNCTION platform.admission_role_identity_is_active()
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
  )
$function$;
REVOKE ALL ON FUNCTION platform.admission_role_identity_is_active() FROM PUBLIC;

CREATE FUNCTION platform.begin_admission_transaction(p_operation TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER SET search_path=pg_catalog,platform
AS $function$
DECLARE current_epoch BIGINT;
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN (
    'admission.command','site.evidence.authorize','site.evidence.record','capability.projection',
    'asset.eligibility.check-active','asset.eligibility.resolve'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='PLATFORM_ADMISSION_OPERATION_INVALID';
  END IF;

  SELECT authority.lease_epoch INTO current_epoch
  FROM platform.runtime_role_identity_authority authority
  JOIN pg_catalog.pg_roles runtime_role
    ON runtime_role.oid::BIGINT=authority.role_oid
   AND runtime_role.rolname=authority.role_name
  WHERE authority.role_kind='admission'
    AND authority.lease_state='active'
    AND runtime_role.rolname=SESSION_USER;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='PLATFORM_ADMISSION_LEASE_INACTIVE';
  END IF;

  PERFORM pg_catalog.set_config('app.operation',p_operation,true);
  PERFORM pg_catalog.set_config('app.workload_kind','platform_admission',true);
  PERFORM pg_catalog.set_config('app.admission_lease_epoch',current_epoch::TEXT,true);
  RETURN current_epoch;
END
$function$;
REVOKE ALL ON FUNCTION platform.begin_admission_transaction(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.admission_role_identity_is_current()
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
      AND current_setting('app.workload_kind',true)='platform_admission'
      AND current_setting('app.operation',true) IN (
        'admission.command','site.evidence.authorize','site.evidence.record','capability.projection',
        'asset.eligibility.check-active','asset.eligibility.resolve'
      )
      AND current_setting('app.admission_lease_epoch',true)=authority.lease_epoch::TEXT
  )
$function$;
REVOKE ALL ON FUNCTION platform.admission_role_identity_is_current() FROM PUBLIC;

DROP POLICY IF EXISTS admission_media_access_scope
  ON platform.admission_media_access_authorization;
CREATE POLICY admission_media_access_scope
  ON platform.admission_media_access_authorization
  USING (
    platform.admission_role_identity_is_current()
    AND current_setting('app.operation',true)='admission.command'
    AND current_setting('app.workload_kind',true)='platform_admission'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
  )
  WITH CHECK (
    platform.admission_role_identity_is_current()
    AND current_setting('app.operation',true)='admission.command'
    AND current_setting('app.workload_kind',true)='platform_admission'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
  );

DROP POLICY credit_execution_root_closure_definer
  ON platform.credit_execution_root_closure_receipt;
CREATE POLICY credit_execution_root_closure_definer
  ON platform.credit_execution_root_closure_receipt TO platform_migrator
  USING (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  )
  WITH CHECK (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  );

DROP POLICY credit_execution_root_reconciliation_definer
  ON platform.credit_execution_root_reconciliation;
CREATE POLICY credit_execution_root_reconciliation_definer
  ON platform.credit_execution_root_reconciliation TO platform_migrator
  USING (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  )
  WITH CHECK (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  );

DROP POLICY credit_execution_root_outcome_definer
  ON platform.credit_execution_root_outcome;
CREATE POLICY credit_execution_root_outcome_definer
  ON platform.credit_execution_root_outcome TO platform_migrator
  USING (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  )
  WITH CHECK (
    SESSION_USER='platform_media_worker'
    OR platform.admission_role_identity_is_current()
  );

DROP POLICY admission_verified_terminal_evidence_definer
  ON platform.admission_verified_terminal_evidence;
CREATE POLICY admission_verified_terminal_evidence_definer
  ON platform.admission_verified_terminal_evidence TO platform_migrator
  USING (platform.admission_role_identity_is_current())
  WITH CHECK (platform.admission_role_identity_is_current());

CREATE OR REPLACE FUNCTION platform.record_admission_verified_terminal_evidence(
  p_site_ref TEXT,p_run_ref TEXT,p_manifest_ref TEXT,p_session_ref TEXT,p_launch_ref TEXT,
  p_terminal_evidence_ref TEXT,p_terminal_outcome TEXT,p_terminal_evidence_digest CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $function$
DECLARE prior platform.admission_verified_terminal_evidence%ROWTYPE;
BEGIN
  IF NOT platform.admission_role_identity_is_current()
    OR p_terminal_outcome NOT IN ('completed','canceled','failed')
    OR p_terminal_evidence_digest !~ '^[a-f0-9]{64}$'
    OR p_site_ref IS NULL OR p_run_ref IS NULL OR p_manifest_ref IS NULL OR p_session_ref IS NULL
    OR p_launch_ref IS NULL OR p_terminal_evidence_ref IS NULL THEN
    RAISE EXCEPTION 'ADMISSION_VERIFIED_TERMINAL_EVIDENCE_INVALID';
  END IF;
  SELECT * INTO prior FROM platform.admission_verified_terminal_evidence
   WHERE site_ref=p_site_ref AND (run_ref=p_run_ref OR terminal_evidence_ref=p_terminal_evidence_ref)
   FOR UPDATE;
  IF FOUND THEN
    IF prior.run_ref IS DISTINCT FROM p_run_ref OR prior.manifest_ref IS DISTINCT FROM p_manifest_ref
      OR prior.session_ref IS DISTINCT FROM p_session_ref OR prior.launch_ref IS DISTINCT FROM p_launch_ref
      OR prior.terminal_evidence_ref IS DISTINCT FROM p_terminal_evidence_ref
      OR prior.terminal_outcome IS DISTINCT FROM p_terminal_outcome
      OR prior.terminal_evidence_digest IS DISTINCT FROM p_terminal_evidence_digest THEN
      RAISE EXCEPTION 'ADMISSION_VERIFIED_TERMINAL_EVIDENCE_CONFLICT';
    END IF;
    RETURN;
  END IF;
  INSERT INTO platform.admission_verified_terminal_evidence(
    site_ref,run_ref,manifest_ref,session_ref,launch_ref,terminal_evidence_ref,
    terminal_outcome,terminal_evidence_digest)
  VALUES (p_site_ref,p_run_ref,p_manifest_ref,p_session_ref,p_launch_ref,p_terminal_evidence_ref,
    p_terminal_outcome,p_terminal_evidence_digest);
END
$function$;

CREATE OR REPLACE FUNCTION platform.assert_execution_root_owner_proof_envelope(
  p_owner_proof JSONB
) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $function$
DECLARE expected_digest CHAR(64);
BEGIN
  IF jsonb_typeof(p_owner_proof)<>'object' OR p_owner_proof->>'proofDigest' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID';
  END IF;
  IF p_owner_proof->>'kind'='media_operation' THEN
    IF SESSION_USER<>'platform_media_worker' THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_ROLE_INVALID';
    END IF;
    IF NOT platform.credit_direct_root_json_exact_keys(p_owner_proof,
      ARRAY['kind','sourceRef','terminalEvidenceRef','outcome','proofDigest','workerLease'])
      OR NOT platform.credit_direct_root_json_exact_keys(p_owner_proof->'workerLease',
        ARRAY['taskRef','leaseEpoch','leaseTokenHash'])
      OR NOT platform.credit_direct_root_is_canonical_positive_bigint(
        p_owner_proof#>>'{workerLease,leaseEpoch}')
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'sourceRef',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'terminalEvidenceRef',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof#>>'{workerLease,taskRef}',256)
      OR p_owner_proof#>>'{workerLease,leaseTokenHash}' !~ '^[a-f0-9]{64}$'
      OR p_owner_proof->>'outcome' NOT IN ('completed','partial','failed','canceled') THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID';
    END IF;
    expected_digest := platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
      'kokoro.platform.credit.owner-proof.media.v1',p_owner_proof->>'sourceRef',
      p_owner_proof->>'terminalEvidenceRef',p_owner_proof->>'outcome',
      p_owner_proof#>>'{workerLease,taskRef}',p_owner_proof#>>'{workerLease,leaseEpoch}',
      p_owner_proof#>>'{workerLease,leaseTokenHash}']);
  ELSIF p_owner_proof->>'kind'='admission_run' THEN
    IF NOT platform.admission_role_identity_is_current() THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_ROLE_INVALID';
    END IF;
    IF NOT platform.credit_direct_root_json_exact_keys(p_owner_proof,
      ARRAY['kind','sourceRef','terminalEvidenceRef','terminalEvidenceDigest','outcome','proofDigest',
        'manifestRef','sessionId','launchId'])
      OR p_owner_proof->>'outcome' NOT IN ('completed','canceled','failed')
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'sourceRef',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'terminalEvidenceRef',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'manifestRef',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'sessionId',256)
      OR NOT platform.credit_direct_root_is_reference(p_owner_proof->>'launchId',256)
      OR p_owner_proof->>'terminalEvidenceDigest' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID';
    END IF;
    expected_digest := platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
      'kokoro.platform.credit.owner-proof.admission.v1',p_owner_proof->>'sourceRef',
      p_owner_proof->>'terminalEvidenceRef',p_owner_proof->>'terminalEvidenceDigest',
      p_owner_proof->>'outcome',p_owner_proof->>'manifestRef',
      p_owner_proof->>'sessionId',p_owner_proof->>'launchId']);
  ELSE
    RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID';
  END IF;
  IF expected_digest IS DISTINCT FROM p_owner_proof->>'proofDigest' THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_DIGEST_INVALID';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION platform.assert_execution_root_owner_proof(
  p_site_ref TEXT,p_owner_proof JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $function$
DECLARE matched BOOLEAN;
BEGIN
  PERFORM platform.assert_execution_root_owner_proof_envelope(p_owner_proof);
  IF p_owner_proof->>'kind'='media_operation' THEN
    IF SESSION_USER<>'platform_media_worker' THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_ROLE_INVALID';
    END IF;
    PERFORM platform.assert_media_image_worker_lease(
      p_owner_proof#>>'{workerLease,taskRef}',p_owner_proof->>'sourceRef',
      (p_owner_proof#>>'{workerLease,leaseEpoch}')::BIGINT,
      p_owner_proof#>>'{workerLease,leaseTokenHash}');
  ELSIF p_owner_proof->>'kind'='admission_run' THEN
    IF NOT platform.admission_role_identity_is_current() THEN
      RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_ROLE_INVALID';
    END IF;
    SELECT TRUE INTO matched FROM platform.admission_verified_terminal_evidence evidence
     WHERE evidence.site_ref=p_site_ref AND evidence.run_ref=p_owner_proof->>'sourceRef'
       AND evidence.manifest_ref=p_owner_proof->>'manifestRef'
       AND evidence.session_ref=p_owner_proof->>'sessionId'
       AND evidence.launch_ref=p_owner_proof->>'launchId'
       AND evidence.terminal_evidence_ref=p_owner_proof->>'terminalEvidenceRef'
       AND evidence.terminal_outcome=p_owner_proof->>'outcome'
       AND evidence.terminal_evidence_digest=p_owner_proof->>'terminalEvidenceDigest';
    IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID'; END IF;
  END IF;
END
$function$;
