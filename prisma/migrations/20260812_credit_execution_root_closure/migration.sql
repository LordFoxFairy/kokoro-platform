SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admission_verified_terminal_evidence (
  site_ref TEXT NOT NULL,
  run_ref TEXT NOT NULL CHECK(length(run_ref) BETWEEN 1 AND 256),
  manifest_ref TEXT NOT NULL CHECK(length(manifest_ref) BETWEEN 1 AND 256),
  session_ref TEXT NOT NULL CHECK(length(session_ref) BETWEEN 1 AND 256),
  launch_ref TEXT NOT NULL CHECK(length(launch_ref) BETWEEN 1 AND 256),
  terminal_evidence_ref TEXT NOT NULL CHECK(length(terminal_evidence_ref) BETWEEN 1 AND 256),
  terminal_outcome TEXT NOT NULL CHECK(terminal_outcome IN ('completed','canceled','failed')),
  terminal_evidence_digest CHAR(64) NOT NULL CHECK(terminal_evidence_digest ~ '^[a-f0-9]{64}$'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_ref,run_ref),
  UNIQUE(site_ref,terminal_evidence_ref)
);

CREATE TABLE platform.credit_execution_root_outcome (
  outcome_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('media_operation','admission_run')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  owner_proof_digest CHAR(64) NOT NULL CHECK(owner_proof_digest ~ '^[a-f0-9]{64}$'),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('closure','reconciliation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,source_kind,source_ref),
  UNIQUE(site_ref,business_operation_key),
  UNIQUE(outcome_ref,site_ref)
);

CREATE TABLE platform.credit_execution_root_closure_receipt (
  allocation_closure_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('media_operation','admission_run')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  owner_proof_digest CHAR(64) NOT NULL CHECK(owner_proof_digest ~ '^[a-f0-9]{64}$'),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  terminal_evidence_ref TEXT NOT NULL CHECK(length(terminal_evidence_ref) BETWEEN 1 AND 256),
  outcome TEXT NOT NULL CHECK(outcome IN ('completed','partial','failed','canceled')),
  execution_manifest_ref TEXT NOT NULL CHECK(length(execution_manifest_ref) BETWEEN 1 AND 256),
  authorization_segment_ref UUID NOT NULL,
  authorization_segment_version BIGINT NOT NULL CHECK(authorization_segment_version>0),
  settlement_ref UUID NOT NULL,
  settlement_closure_ref UUID NOT NULL,
  settlement_closure_revision BIGINT NOT NULL CHECK(settlement_closure_revision>0),
  platform_exposure_amount NUMERIC(38,0) NOT NULL CHECK(platform_exposure_amount>=0),
  rating_snapshot_ref UUID NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  root_allocation_ref UUID NOT NULL,
  root_hold_ref UUID NOT NULL,
  allocation_before_revision BIGINT NOT NULL CHECK(allocation_before_revision>0),
  allocation_after_revision BIGINT NOT NULL CHECK(allocation_after_revision=allocation_before_revision+1),
  allocation_before_epoch BIGINT NOT NULL CHECK(allocation_before_epoch>0),
  allocation_after_epoch BIGINT NOT NULL CHECK(allocation_after_epoch=allocation_before_epoch+1),
  root_before_version BIGINT NOT NULL CHECK(root_before_version>0),
  root_after_version BIGINT NOT NULL CHECK(root_after_version=root_before_version+1),
  hold_before_fence BIGINT NOT NULL CHECK(hold_before_fence>0),
  hold_after_fence BIGINT NOT NULL CHECK(hold_after_fence=hold_before_fence+1),
  captured_amount NUMERIC(38,0) NOT NULL CHECK(captured_amount>=0),
  released_amount NUMERIC(38,0) NOT NULL CHECK(released_amount>=0),
  reserved_ceiling NUMERIC(38,0) NOT NULL CHECK(reserved_ceiling>0),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  release_journal_transaction_ref UUID,
  receipt_digest CHAR(64) NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,business_operation_key),
  UNIQUE(site_ref,source_kind,source_ref),
  UNIQUE(allocation_closure_receipt_ref,site_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(root_allocation_ref,allocation_before_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref),
  FOREIGN KEY(root_allocation_ref,allocation_after_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref),
  FOREIGN KEY(root_hold_ref,site_ref)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(settlement_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(settlement_closure_ref,site_ref,authorization_segment_ref,settlement_closure_revision)
    REFERENCES platform.credit_usage_segment_closure(
      closure_ref,site_ref,authorization_segment_ref,closure_revision),
  FOREIGN KEY(rating_snapshot_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_rating_snapshot(rating_snapshot_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(release_journal_transaction_ref,site_ref)
    REFERENCES platform.credit_journal_transaction(journal_transaction_ref,site_ref),
  CHECK(captured_amount+released_amount=reserved_ceiling),
  CHECK((released_amount=0)=(release_journal_transaction_ref IS NULL))
);

CREATE TABLE platform.credit_execution_root_reconciliation (
  reconciliation_receipt_ref UUID PRIMARY KEY,
  reconciliation_allocation_revision_ref UUID NOT NULL UNIQUE,
  site_ref TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('media_operation','admission_run')),
  source_ref TEXT NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 256),
  owner_proof_digest CHAR(64) NOT NULL CHECK(owner_proof_digest ~ '^[a-f0-9]{64}$'),
  terminal_evidence_ref TEXT NOT NULL CHECK(length(terminal_evidence_ref) BETWEEN 1 AND 256),
  execution_budget_root_ref UUID NOT NULL,
  root_allocation_ref UUID NOT NULL,
  root_hold_ref UUID NOT NULL,
  allocation_before_revision BIGINT NOT NULL CHECK(allocation_before_revision>0),
  allocation_after_revision BIGINT NOT NULL CHECK(allocation_after_revision=allocation_before_revision+1),
  allocation_before_epoch BIGINT NOT NULL CHECK(allocation_before_epoch>0),
  allocation_after_epoch BIGINT NOT NULL CHECK(allocation_after_epoch=allocation_before_epoch+1),
  root_before_version BIGINT NOT NULL CHECK(root_before_version>0),
  root_after_version BIGINT NOT NULL CHECK(root_after_version=root_before_version+1),
  hold_before_fence BIGINT NOT NULL CHECK(hold_before_fence>0),
  hold_after_fence BIGINT NOT NULL CHECK(hold_after_fence=hold_before_fence+1),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 256),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,business_operation_key),
  UNIQUE(site_ref,source_kind,source_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(root_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(root_allocation_ref,allocation_after_revision,site_ref,execution_budget_root_ref)
    REFERENCES platform.credit_budget_allocation_revision(
      budget_allocation_ref,revision,site_ref,execution_budget_root_ref),
  FOREIGN KEY(reconciliation_allocation_revision_ref)
    REFERENCES platform.credit_budget_allocation_revision(allocation_revision_ref),
  FOREIGN KEY(root_hold_ref,site_ref)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref),
  CHECK(reconciliation_receipt_ref<>reconciliation_allocation_revision_ref)
);

ALTER TABLE platform.credit_execution_root_closure_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_execution_root_closure_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_execution_root_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_execution_root_reconciliation FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_execution_root_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_execution_root_outcome FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_verified_terminal_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_verified_terminal_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE platform.credit_execution_root_closure_receipt,
  platform.credit_execution_root_reconciliation,platform.credit_execution_root_outcome,
  platform.admission_verified_terminal_evidence FROM PUBLIC;
CREATE POLICY credit_execution_root_closure_definer
  ON platform.credit_execution_root_closure_receipt TO platform_migrator
  USING(SESSION_USER IN ('platform_media_worker','platform_admission'))
  WITH CHECK(SESSION_USER IN ('platform_media_worker','platform_admission'));
CREATE POLICY credit_execution_root_reconciliation_definer
  ON platform.credit_execution_root_reconciliation TO platform_migrator
  USING(SESSION_USER IN ('platform_media_worker','platform_admission'))
  WITH CHECK(SESSION_USER IN ('platform_media_worker','platform_admission'));
CREATE POLICY credit_execution_root_outcome_definer
  ON platform.credit_execution_root_outcome TO platform_migrator
  USING(SESSION_USER IN ('platform_media_worker','platform_admission'))
  WITH CHECK(SESSION_USER IN ('platform_media_worker','platform_admission'));
CREATE POLICY admission_verified_terminal_evidence_definer
  ON platform.admission_verified_terminal_evidence TO platform_migrator
  USING(SESSION_USER='platform_admission') WITH CHECK(SESSION_USER='platform_admission');

CREATE FUNCTION platform.reject_credit_execution_root_fact_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_FACT_IMMUTABLE' USING ERRCODE='23000';
END $$;
CREATE TRIGGER credit_execution_root_closure_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_execution_root_closure_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_execution_root_fact_mutation();
CREATE TRIGGER credit_execution_root_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_execution_root_reconciliation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_execution_root_fact_mutation();
CREATE TRIGGER credit_execution_root_outcome_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_execution_root_outcome
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_execution_root_fact_mutation();
CREATE TRIGGER admission_verified_terminal_evidence_immutable
  BEFORE UPDATE OR DELETE ON platform.admission_verified_terminal_evidence
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_execution_root_fact_mutation();
REVOKE ALL ON FUNCTION platform.reject_credit_execution_root_fact_mutation() FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_json_exact_keys(p_value JSONB,p_expected TEXT[])
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT jsonb_typeof(p_value)='object'
    AND ARRAY(SELECT key FROM jsonb_object_keys(p_value) AS key ORDER BY key)
      = ARRAY(SELECT key FROM unnest(p_expected) AS key ORDER BY key)
$$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_json_exact_keys(JSONB,TEXT[]) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_is_reference(value TEXT,maximum_length INTEGER)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT value IS NOT NULL AND length(value) BETWEEN 1 AND maximum_length
    AND value !~ '[[:cntrl:]]'
$$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_is_reference(TEXT,INTEGER) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_is_canonical_uuid(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,platform AS $$
DECLARE parsed UUID;
BEGIN
  IF value IS NULL OR value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN FALSE;
  END IF;
  BEGIN parsed := value::UUID;
  EXCEPTION WHEN invalid_text_representation THEN RETURN FALSE;
  END;
  RETURN parsed::TEXT=value;
END $$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_is_canonical_uuid(TEXT) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_is_canonical_positive_bigint(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,platform AS $$
DECLARE parsed BIGINT;
BEGIN
  IF value IS NULL OR value !~ '^[1-9][0-9]*$' THEN RETURN FALSE; END IF;
  BEGIN parsed := value::BIGINT;
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN FALSE;
  END;
  RETURN parsed::TEXT=value;
END $$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_is_canonical_positive_bigint(TEXT) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_is_canonical_nonnegative_amount(value TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,platform AS $$
DECLARE parsed NUMERIC(38,0);
BEGIN
  IF value IS NULL OR value !~ '^(0|[1-9][0-9]*)$' THEN RETURN FALSE; END IF;
  BEGIN parsed := value::NUMERIC(38,0);
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN RETURN FALSE;
  END;
  RETURN parsed::TEXT=value;
END $$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_is_canonical_nonnegative_amount(TEXT) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_commit_values_canonical(p_record JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT COALESCE(
    p_record#>>'{identity,ownerProof,proofDigest}' ~ '^[a-f0-9]{64}$'
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,budget,executionBudgetRootRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,budget,rootHoldRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,budget,rootAllocationRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,budget,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,rootAllocationRevision}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,rootAllocationEpoch}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,authorizationSegmentVersion}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,budget,reservedCeiling}')
    AND p_record#>>'{command,budget,reservedCeiling}'<>'0'
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,settlement,settlementRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,settlement,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,settlement,closureRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,settlement,closureRevision}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,settlement,customerAmount}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,settlement,platformExposureAmount}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(p_record#>>'{result,allocation,revision}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{result,allocation,allocationEpoch}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,creditCeiling}')
    AND p_record#>>'{result,allocation,creditCeiling}'<>'0'
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,unassignedStock}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,activeChildReservedStock}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,committedStock}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,capturedCumulative}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,allocation,returnedToParentCumulative}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,allocationRevisionRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(p_record#>>'{result,rootVersion}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(p_record#>>'{result,holdFenceEpoch}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(p_record#>>'{result,capturedAmount}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(p_record#>>'{result,releasedAmount}')
    AND (p_record#>>'{result,releaseJournalTransactionRef}' IS NULL
      OR platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,releaseJournalTransactionRef}'))
    AND (p_record#>>'{result,releaseEntriesDigest}' IS NULL
      OR p_record#>>'{result,releaseEntriesDigest}' ~ '^[a-f0-9]{64}$')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{result,receipt,allocationClosureReceiptRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,receipt,settlementRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{result,receipt,executionBudgetRootRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,receipt,rootAllocationRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,receipt,rootHoldRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{result,receipt,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{result,receipt,authorizationSegmentVersion}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{result,receipt,settlementClosureRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{result,receipt,settlementClosureRevision}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,receipt,platformExposureAmount}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,receipt,ratingSnapshotRef}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,receipt,capturedAmount}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{result,receipt,releasedAmount}')
    AND p_record#>>'{result,receipt,receiptDigest}' ~ '^[a-f0-9]{64}$'
  ,FALSE)
$$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_commit_values_canonical(JSONB) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_reconciliation_values_canonical(p_record JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT COALESCE(
    p_record#>>'{identity,ownerProof,proofDigest}' ~ '^[a-f0-9]{64}$'
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,budget,executionBudgetRootRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,budget,rootHoldRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,budget,rootAllocationRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,budget,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,rootAllocationRevision}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,rootAllocationEpoch}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,budget,authorizationSegmentVersion}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,budget,reservedCeiling}')
    AND p_record#>>'{command,budget,reservedCeiling}'<>'0'
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,settlement,settlementRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{command,settlement,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{command,settlement,closureRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{command,settlement,closureRevision}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,settlement,customerAmount}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{command,settlement,platformExposureAmount}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{authority,executionBudgetRootRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{authority,rootAllocationRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{authority,rootHoldRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{authority,authorizationSegmentRef}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{authority,settlementRef}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,rootAllocationRevision}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,rootAllocationEpoch}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,authorizationSegmentVersion}')
    AND platform.credit_direct_root_is_canonical_nonnegative_amount(
      p_record#>>'{authority,reservedCeiling}')
    AND p_record#>>'{authority,reservedCeiling}'<>'0'
    AND platform.credit_direct_root_is_canonical_positive_bigint(p_record#>>'{authority,expectedRootVersion}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,expectedHoldFenceEpoch}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,expectedAllocationRevision}')
    AND platform.credit_direct_root_is_canonical_positive_bigint(
      p_record#>>'{authority,expectedAllocationEpoch}')
    AND platform.credit_direct_root_is_canonical_uuid(p_record#>>'{result,reconciliationReceiptRef}')
    AND platform.credit_direct_root_is_canonical_uuid(
      p_record#>>'{result,reconciliationAllocationRevisionRef}')
  ,FALSE)
$$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_reconciliation_values_canonical(JSONB) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_lock_outcome(
  p_site_ref TEXT,p_source_kind TEXT,p_source_ref TEXT,p_business_operation_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE source_lock BIGINT; business_lock BIGINT;
BEGIN
  source_lock := hashtextextended('kokoro.credit.execution-root.source.v1'||chr(0)||p_site_ref||chr(0)||
    p_source_kind||chr(0)||p_source_ref,0);
  business_lock := hashtextextended('kokoro.credit.execution-root.business.v1'||chr(0)||p_site_ref||chr(0)||
    p_business_operation_key,0);
  PERFORM pg_advisory_xact_lock(LEAST(source_lock,business_lock));
  IF source_lock<>business_lock THEN
    PERFORM pg_advisory_xact_lock(GREATEST(source_lock,business_lock));
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_lock_outcome(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.credit_direct_root_framed_digest(VARIADIC p_values TEXT[])
RETURNS CHAR(64)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT encode(sha256(convert_to(array_to_string(ARRAY(
    SELECT octet_length(value)::TEXT||':'||value
      FROM unnest(p_values) WITH ORDINALITY AS item(value,position)
     ORDER BY position
  ),'|'),'UTF8')),'hex')::CHAR(64)
$$;
REVOKE ALL ON FUNCTION platform.credit_direct_root_framed_digest(VARIADIC TEXT[]) FROM PUBLIC;

CREATE FUNCTION platform.record_admission_verified_terminal_evidence(
  p_site_ref TEXT,p_run_ref TEXT,p_manifest_ref TEXT,p_session_ref TEXT,p_launch_ref TEXT,
  p_terminal_evidence_ref TEXT,p_terminal_outcome TEXT,p_terminal_evidence_digest CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.admission_verified_terminal_evidence%ROWTYPE;
BEGIN
  IF SESSION_USER<>'platform_admission' OR p_terminal_outcome NOT IN ('completed','canceled','failed')
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
END $$;
REVOKE ALL ON FUNCTION platform.record_admission_verified_terminal_evidence(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.record_admission_verified_terminal_evidence(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,CHAR) TO platform_admission;

CREATE FUNCTION platform.assert_execution_root_owner_proof_envelope(p_owner_proof JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
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
    IF SESSION_USER<>'platform_admission' THEN
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
      p_owner_proof->>'terminalEvidenceRef',p_owner_proof->>'terminalEvidenceDigest',p_owner_proof->>'outcome',
      p_owner_proof->>'manifestRef',p_owner_proof->>'sessionId',p_owner_proof->>'launchId']);
  ELSE
    RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_INVALID';
  END IF;
  IF expected_digest IS DISTINCT FROM p_owner_proof->>'proofDigest' THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_ROOT_OWNER_PROOF_DIGEST_INVALID';
  END IF;
END $$;
REVOKE ALL ON FUNCTION platform.assert_execution_root_owner_proof_envelope(JSONB) FROM PUBLIC;

CREATE FUNCTION platform.assert_execution_root_owner_proof(
  p_site_ref TEXT,p_owner_proof JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
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
    IF SESSION_USER<>'platform_admission' THEN
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
END $$;
REVOKE ALL ON FUNCTION platform.assert_execution_root_owner_proof(TEXT,JSONB) FROM PUBLIC;

CREATE FUNCTION platform.execution_root_closure_receipt_json(
  receipt platform.credit_execution_root_closure_receipt
) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT jsonb_build_object(
    'allocationClosureReceiptRef',receipt.allocation_closure_receipt_ref::TEXT,
    'siteId',receipt.site_ref,'sourceKind',receipt.source_kind,'sourceRef',receipt.source_ref,
    'ownerProofDigest',receipt.owner_proof_digest,
    'businessOperationKey',receipt.business_operation_key,'requestDigest',receipt.request_digest,
    'terminalEvidenceRef',receipt.terminal_evidence_ref,'outcome',receipt.outcome,
    'executionManifestRef',receipt.execution_manifest_ref,
    'authorizationSegmentRef',receipt.authorization_segment_ref::TEXT,
    'authorizationSegmentVersion',receipt.authorization_segment_version::TEXT,
    'settlementRef',receipt.settlement_ref::TEXT,
    'settlementClosureRef',receipt.settlement_closure_ref::TEXT,
    'settlementClosureRevision',receipt.settlement_closure_revision::TEXT,
    'platformExposureAmount',receipt.platform_exposure_amount::TEXT,
    'ratingSnapshotRef',receipt.rating_snapshot_ref::TEXT,
    'executionBudgetRootRef',receipt.execution_budget_root_ref::TEXT,
    'rootAllocationRef',receipt.root_allocation_ref::TEXT,'rootHoldRef',receipt.root_hold_ref::TEXT,
    'capturedAmount',receipt.captured_amount::TEXT,'releasedAmount',receipt.released_amount::TEXT,
    'unit',receipt.unit,'receiptDigest',receipt.receipt_digest,
    'recordedAt',to_char(receipt.recorded_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;
REVOKE ALL ON FUNCTION platform.execution_root_closure_receipt_json(
  platform.credit_execution_root_closure_receipt) FROM PUBLIC;

CREATE FUNCTION platform.find_execution_root_closure(
  p_site_ref TEXT,p_owner_proof JSONB,p_business_operation_key TEXT,p_request_digest CHAR(64)
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE authority platform.credit_execution_root_outcome%ROWTYPE;
  closure_prior platform.credit_execution_root_closure_receipt%ROWTYPE;
  reconciliation_prior platform.credit_execution_root_reconciliation%ROWTYPE;
BEGIN
  PERFORM platform.assert_execution_root_owner_proof_envelope(p_owner_proof);
  SELECT * INTO authority FROM platform.credit_execution_root_outcome
   WHERE site_ref=p_site_ref AND (business_operation_key=p_business_operation_key OR
     (source_kind=p_owner_proof->>'kind' AND source_ref=p_owner_proof->>'sourceRef'));
  IF NOT FOUND THEN
    PERFORM platform.assert_execution_root_owner_proof(p_site_ref,p_owner_proof);
    RETURN jsonb_build_object('kind','none');
  END IF;
  IF authority.business_operation_key IS DISTINCT FROM p_business_operation_key
    OR authority.source_kind IS DISTINCT FROM p_owner_proof->>'kind'
    OR authority.source_ref IS DISTINCT FROM p_owner_proof->>'sourceRef'
    OR authority.owner_proof_digest IS DISTINCT FROM p_owner_proof->>'proofDigest'
    OR authority.request_digest IS DISTINCT FROM p_request_digest THEN
    RETURN jsonb_build_object('kind','conflict');
  END IF;
  IF authority.outcome_kind='closure' THEN
    SELECT * INTO STRICT closure_prior FROM platform.credit_execution_root_closure_receipt
     WHERE site_ref=p_site_ref AND allocation_closure_receipt_ref=authority.outcome_ref;
    RETURN jsonb_build_object('kind','replayed','value',
      platform.execution_root_closure_receipt_json(closure_prior));
  ELSIF authority.outcome_kind='reconciliation' THEN
    SELECT * INTO STRICT reconciliation_prior FROM platform.credit_execution_root_reconciliation
     WHERE site_ref=p_site_ref AND reconciliation_receipt_ref=authority.outcome_ref;
    RETURN jsonb_build_object('kind','reconciliation_required',
      'reconciliationReceiptRef',reconciliation_prior.reconciliation_receipt_ref::TEXT,
      'code',reconciliation_prior.code);
  END IF;
  RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_OUTCOME_CORRUPT';
END $$;
REVOKE ALL ON FUNCTION platform.find_execution_root_closure(TEXT,JSONB,TEXT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.find_execution_root_closure(TEXT,JSONB,TEXT,CHAR)
  TO platform_media_worker,platform_admission;

CREATE FUNCTION platform.lock_execution_root_closure(
  p_site_ref TEXT,p_owner_proof JSONB,p_business_operation_key TEXT,p_execution_budget_root_ref UUID,
  p_root_allocation_ref UUID,p_root_hold_ref UUID,p_authorization_segment_ref UUID,p_settlement_ref UUID,
  p_execution_manifest_ref TEXT,p_root_allocation_revision BIGINT,p_root_allocation_epoch BIGINT,
  p_authorization_segment_version BIGINT,p_reserved_ceiling NUMERIC,p_unit TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE context RECORD; sources JSONB; open_children BIGINT; open_segments BIGINT; open_attempts BIGINT;
BEGIN
  PERFORM platform.assert_execution_root_owner_proof(p_site_ref,p_owner_proof);
  PERFORM platform.credit_direct_root_lock_outcome(
    p_site_ref,p_owner_proof->>'kind',p_owner_proof->>'sourceRef',p_business_operation_key);
  SELECT root.state AS root_state,root.aggregate_version,root.billing_account_ref,
         root.credit_account_ref,root.liability_merchant_account_ref,
         hold.state AS hold_state,hold.fence_epoch,hold.reserved_amount,hold.captured_amount,
         hold.released_amount,revision.revision,revision.allocation_epoch,revision.credit_ceiling,
         revision.unassigned_stock,revision.active_child_reserved_stock,revision.committed_stock,
         revision.captured_cumulative,revision.returned_to_parent_cumulative,
         revision.state AS allocation_state,segment.execution_manifest_ref,
         segment.prepared_against_allocation_revision AS root_allocation_revision,
         segment.allocation_epoch AS root_allocation_epoch,
         segment.aggregate_version AS authorization_segment_version,
         settlement.authorization_segment_ref,settlement.execution_budget_root_ref AS settlement_root_ref,
         settlement.budget_allocation_ref AS settlement_allocation_ref,
         settlement.credit_hold_ref AS settlement_hold_ref,settlement.unit AS settlement_unit,
         settlement.customer_amount,settlement.closure_ref,settlement.closure_revision,
         settlement.platform_exposure_amount,settlement.rating_snapshot_ref
    INTO context
    FROM platform.credit_execution_budget_root root
    JOIN platform.credit_hold hold ON hold.credit_hold_ref=root.credit_hold_ref AND hold.site_ref=root.site_ref
    JOIN platform.credit_budget_allocation allocation
      ON allocation.budget_allocation_ref=root.root_allocation_ref AND allocation.site_ref=root.site_ref
    JOIN platform.credit_budget_allocation_revision revision
      ON revision.budget_allocation_ref=allocation.budget_allocation_ref
     AND revision.revision=allocation.current_revision
    JOIN platform.credit_authorization_segment segment
      ON segment.authorization_segment_ref=p_authorization_segment_ref AND segment.site_ref=root.site_ref
     AND segment.execution_budget_root_ref=root.execution_budget_root_ref
     AND segment.budget_allocation_ref=allocation.budget_allocation_ref
     AND segment.credit_hold_ref=hold.credit_hold_ref
     AND segment.execution_manifest_ref=p_execution_manifest_ref
     AND segment.state='settled'
    JOIN platform.credit_usage_settlement settlement
      ON settlement.settlement_ref=p_settlement_ref AND settlement.site_ref=root.site_ref
     AND settlement.authorization_segment_ref=segment.authorization_segment_ref
    JOIN platform.credit_rating_snapshot snapshot
      ON snapshot.rating_snapshot_ref=settlement.rating_snapshot_ref AND snapshot.site_ref=root.site_ref
     AND snapshot.authorization_segment_ref=segment.authorization_segment_ref
   WHERE root.site_ref=p_site_ref AND root.execution_budget_root_ref=p_execution_budget_root_ref
     AND root.execution_root_ref=p_owner_proof->>'sourceRef'
     AND root.root_allocation_ref=p_root_allocation_ref AND root.credit_hold_ref=p_root_hold_ref
     AND root.reserved_ceiling=p_reserved_ceiling AND root.unit=p_unit
     AND segment.prepared_against_allocation_revision=p_root_allocation_revision
     AND segment.allocation_epoch=p_root_allocation_epoch
     AND segment.aggregate_version=p_authorization_segment_version
     AND allocation.is_root AND allocation.parent_allocation_ref IS NULL AND allocation.audience='root'
   FOR UPDATE OF root,hold,allocation,revision,segment,settlement;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT count(*) INTO open_children FROM platform.credit_budget_allocation child
  JOIN platform.credit_budget_allocation_revision child_revision
    ON child_revision.budget_allocation_ref=child.budget_allocation_ref
   AND child_revision.revision=child.current_revision
   WHERE child.site_ref=p_site_ref AND child.execution_budget_root_ref=p_execution_budget_root_ref
     AND NOT child.is_root AND child_revision.state<>'terminal';
  SELECT count(*) INTO open_segments FROM platform.credit_authorization_segment segment
   WHERE segment.site_ref=p_site_ref AND segment.execution_budget_root_ref=p_execution_budget_root_ref
     AND segment.state NOT IN ('settled','released','expired');
  SELECT count(*) INTO open_attempts FROM platform.credit_usage_attempt_intent attempt
   WHERE attempt.site_ref=p_site_ref AND attempt.execution_budget_root_ref=p_execution_budget_root_ref
     AND attempt.state<>'finalized';
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'creditGrantId',source.credit_grant_id::TEXT,'ordinal',source.allocation_ordinal::TEXT,
      'allocatedAmount',source.allocated_amount::TEXT,'netCustomerAmount',source.net_customer_amount::TEXT)
      ORDER BY source.allocation_ordinal),'[]'::JSONB) INTO sources
    FROM (
      SELECT allocation.credit_grant_id,allocation.allocation_ordinal,allocation.allocated_amount,
             COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
               THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS net_customer_amount
        FROM platform.credit_hold_allocation allocation
        LEFT JOIN platform.credit_usage_settlement_source settlement_source
          ON settlement_source.credit_hold_ref=allocation.credit_hold_ref
         AND settlement_source.credit_grant_id=allocation.credit_grant_id
       WHERE allocation.credit_hold_ref=p_root_hold_ref AND allocation.site_ref=p_site_ref
       GROUP BY allocation.credit_grant_id,allocation.allocation_ordinal,allocation.allocated_amount
    ) source;
  RETURN jsonb_build_object(
    'siteId',p_site_ref,'sourceKind',p_owner_proof->>'kind','sourceRef',p_owner_proof->>'sourceRef',
    'executionBudgetRootRef',p_execution_budget_root_ref::TEXT,
    'rootState',context.root_state,'rootVersion',context.aggregate_version::TEXT,
    'billingAccountId',context.billing_account_ref,'creditAccountId',context.credit_account_ref::TEXT,
    'liabilityMerchantAccountId',context.liability_merchant_account_ref,
    'creditHoldRef',p_root_hold_ref::TEXT,'holdState',context.hold_state,
    'holdFenceEpoch',context.fence_epoch::TEXT,'holdReservedAmount',context.reserved_amount::TEXT,
    'holdCapturedAmount',context.captured_amount::TEXT,'holdReleasedAmount',context.released_amount::TEXT,
    'rootAllocationRef',p_root_allocation_ref::TEXT,
    'sourceBudget',jsonb_build_object('executionManifestRef',context.execution_manifest_ref,
      'rootAllocationRevision',context.root_allocation_revision::TEXT,
      'rootAllocationEpoch',context.root_allocation_epoch::TEXT,
      'authorizationSegmentVersion',context.authorization_segment_version::TEXT,
      'reservedCeiling',p_reserved_ceiling::TEXT,'unit',p_unit),
    'allocation',jsonb_build_object('revision',context.revision::TEXT,
      'allocationEpoch',context.allocation_epoch::TEXT,'creditCeiling',context.credit_ceiling::TEXT,
      'unassignedStock',context.unassigned_stock::TEXT,
      'activeChildReservedStock',context.active_child_reserved_stock::TEXT,
      'committedStock',context.committed_stock::TEXT,'capturedCumulative',context.captured_cumulative::TEXT,
      'returnedToParentCumulative',context.returned_to_parent_cumulative::TEXT,'state',context.allocation_state),
    'openChildCount',open_children::TEXT,'openSegmentCount',open_segments::TEXT,
    'openAttemptCount',open_attempts::TEXT,
    'settlement',jsonb_build_object('settlementRef',p_settlement_ref::TEXT,
      'authorizationSegmentRef',context.authorization_segment_ref::TEXT,
      'executionBudgetRootRef',context.settlement_root_ref::TEXT,
      'budgetAllocationRef',context.settlement_allocation_ref::TEXT,
      'creditHoldRef',context.settlement_hold_ref::TEXT,'unit',context.settlement_unit,
      'customerAmount',context.customer_amount::TEXT,'closureRef',context.closure_ref::TEXT,
      'closureRevision',context.closure_revision::TEXT,
      'platformExposureAmount',context.platform_exposure_amount::TEXT,
      'ratingSnapshotRef',context.rating_snapshot_ref::TEXT),
    'holdAllocations',sources);
END $$;
REVOKE ALL ON FUNCTION platform.lock_execution_root_closure(
  TEXT,JSONB,TEXT,UUID,UUID,UUID,UUID,UUID,TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.lock_execution_root_closure(
  TEXT,JSONB,TEXT,UUID,UUID,UUID,UUID,UUID,TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,TEXT)
  TO platform_media_worker,platform_admission;

CREATE FUNCTION platform.commit_execution_root_closure(p_record JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.credit_execution_root_closure_receipt%ROWTYPE;
  outcome_prior platform.credit_execution_root_outcome%ROWTYPE;
  identity JSONB; owner_proof JSONB; command JSONB; budget JSONB; settlement JSONB;
  result JSONB; allocation JSONB; receipt JSONB; context JSONB; release JSONB; source RECORD;
  entry_ordinal INTEGER := 0; release_total NUMERIC(38,0) := 0;
  captured NUMERIC(38,0); released NUMERIC(38,0); release_ref UUID;
  source_allocated_total NUMERIC(38,0); source_captured_total NUMERIC(38,0);
  release_count BIGINT; release_grant_count BIGINT; release_ordinal_count BIGINT;
  expected_request_digest CHAR(64); expected_receipt_digest CHAR(64); expected_release_digest TEXT;
  expected_releases JSONB;
BEGIN
  IF octet_length(p_record::TEXT)>131072
    OR NOT platform.credit_direct_root_json_exact_keys(p_record,ARRAY['identity','command','result'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'identity',
      ARRAY['siteId','ownerProof','businessOperationKey','requestDigest'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'command',
      ARRAY['terminalEvidenceRef','outcome','budget','settlement'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{command,budget}',ARRAY[
      'executionBudgetRootRef','executionManifestRef','rootHoldRef','rootAllocationRef',
      'rootAllocationRevision','rootAllocationEpoch','authorizationSegmentRef',
      'authorizationSegmentVersion','reservedCeiling','unit'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{command,settlement}',ARRAY[
      'settlementRef','authorizationSegmentRef','closureRef','closureRevision','state',
      'customerAmount','platformExposureAmount'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'result',ARRAY[
      'allocation','allocationRevisionRef','rootState','rootVersion','holdState','holdFenceEpoch',
      'capturedAmount','releasedAmount','releases','releaseJournalTransactionRef',
      'releaseEntriesDigest','receipt'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{result,allocation}',ARRAY[
      'revision','allocationEpoch','creditCeiling','unassignedStock','activeChildReservedStock',
      'committedStock','capturedCumulative','returnedToParentCumulative','state'])
    OR jsonb_typeof(p_record#>'{result,releases}')<>'array'
    OR jsonb_array_length(p_record#>'{result,releases}')>256
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{result,receipt}',ARRAY[
      'allocationClosureReceiptRef','siteId','sourceKind','sourceRef','ownerProofDigest',
      'businessOperationKey','requestDigest','terminalEvidenceRef','settlementRef',
      'executionBudgetRootRef','rootAllocationRef','rootHoldRef',
      'capturedAmount','releasedAmount','unit','outcome','executionManifestRef',
      'authorizationSegmentRef','authorizationSegmentVersion','settlementClosureRef',
      'settlementClosureRevision','platformExposureAmount','ratingSnapshotRef','receiptDigest','recordedAt']) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_COMMAND_SHAPE_INVALID';
  END IF;
  IF NOT platform.credit_direct_root_commit_values_canonical(p_record) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID';
  END IF;
  identity := p_record->'identity'; owner_proof := identity->'ownerProof'; command := p_record->'command';
  budget := command->'budget'; settlement := command->'settlement'; result := p_record->'result';
  allocation := result->'allocation'; receipt := result->'receipt';
  IF identity->>'requestDigest' !~ '^[a-f0-9]{64}$'
    OR owner_proof->>'proofDigest' !~ '^[a-f0-9]{64}$'
    OR command->>'outcome' NOT IN ('completed','partial','failed','canceled')
    OR command->>'outcome' IS DISTINCT FROM owner_proof->>'outcome'
    OR command->>'terminalEvidenceRef' IS DISTINCT FROM owner_proof->>'terminalEvidenceRef'
    OR settlement->>'state'<>'settled' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_COMMAND_VALUE_INVALID';
  END IF;
  IF receipt->>'recordedAt' !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_TIMESTAMP_INVALID';
  END IF;
  IF to_char((receipt->>'recordedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM receipt->>'recordedAt' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_TIMESTAMP_INVALID';
  END IF;
  FOR release IN SELECT value FROM jsonb_array_elements(result->'releases') LOOP
    IF NOT platform.credit_direct_root_json_exact_keys(release,ARRAY['creditGrantId','ordinal','amount'])
      OR NOT platform.credit_direct_root_is_canonical_uuid(release->>'creditGrantId')
      OR NOT platform.credit_direct_root_is_canonical_nonnegative_amount(release->>'ordinal')
      OR NOT platform.credit_direct_root_is_canonical_nonnegative_amount(release->>'amount')
      OR release->>'amount'='0' THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID';
    END IF;
    IF (release->>'ordinal')::NUMERIC>2147483647 OR (release->>'amount')::NUMERIC<=0 THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_SOURCE_INVALID';
    END IF;
  END LOOP;
  PERFORM platform.assert_execution_root_owner_proof(identity->>'siteId',owner_proof);
  PERFORM platform.credit_direct_root_lock_outcome(
    identity->>'siteId',owner_proof->>'kind',owner_proof->>'sourceRef',identity->>'businessOperationKey');
  expected_request_digest := platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
    'kokoro.platform.credit.execution-root.request.v1',identity->>'siteId',owner_proof->>'kind',
    owner_proof->>'sourceRef',owner_proof->>'terminalEvidenceRef',owner_proof->>'outcome',
    owner_proof->>'proofDigest',
    budget->>'executionBudgetRootRef',budget->>'executionManifestRef',budget->>'rootHoldRef',
    budget->>'rootAllocationRef',budget->>'rootAllocationRevision',budget->>'rootAllocationEpoch',
    budget->>'authorizationSegmentRef',budget->>'authorizationSegmentVersion',
    budget->>'reservedCeiling',budget->>'unit',settlement->>'settlementRef',
    settlement->>'authorizationSegmentRef',settlement->>'closureRef',
    settlement->>'closureRevision',settlement->>'state',settlement->>'customerAmount',
    settlement->>'platformExposureAmount']);
  IF expected_request_digest IS DISTINCT FROM identity->>'requestDigest' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_REQUEST_DIGEST_INVALID';
  END IF;
  SELECT * INTO outcome_prior FROM platform.credit_execution_root_outcome
   WHERE site_ref=identity->>'siteId'
     AND (business_operation_key=identity->>'businessOperationKey'
       OR (source_kind=owner_proof->>'kind' AND source_ref=owner_proof->>'sourceRef')) FOR UPDATE;
  IF FOUND THEN
    IF outcome_prior.business_operation_key IS DISTINCT FROM identity->>'businessOperationKey'
      OR outcome_prior.source_kind IS DISTINCT FROM owner_proof->>'kind'
      OR outcome_prior.source_ref IS DISTINCT FROM owner_proof->>'sourceRef'
      OR outcome_prior.owner_proof_digest IS DISTINCT FROM owner_proof->>'proofDigest'
      OR outcome_prior.request_digest IS DISTINCT FROM identity->>'requestDigest'
      OR outcome_prior.outcome_kind IS DISTINCT FROM 'closure' THEN
      RETURN jsonb_build_object('kind','conflict');
    END IF;
    SELECT * INTO STRICT prior FROM platform.credit_execution_root_closure_receipt
     WHERE site_ref=identity->>'siteId' AND allocation_closure_receipt_ref=outcome_prior.outcome_ref;
    RETURN jsonb_build_object('kind','replayed','value',platform.execution_root_closure_receipt_json(prior));
  END IF;
  context := platform.lock_execution_root_closure(
    identity->>'siteId',owner_proof,identity->>'businessOperationKey',(budget->>'executionBudgetRootRef')::UUID,
    (budget->>'rootAllocationRef')::UUID,(budget->>'rootHoldRef')::UUID,
    (budget->>'authorizationSegmentRef')::UUID,(settlement->>'settlementRef')::UUID,
    budget->>'executionManifestRef',(budget->>'rootAllocationRevision')::BIGINT,
    (budget->>'rootAllocationEpoch')::BIGINT,(budget->>'authorizationSegmentVersion')::BIGINT,
    (budget->>'reservedCeiling')::NUMERIC,budget->>'unit');
  IF context IS NULL THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_CONTEXT_NOT_FOUND'; END IF;
  captured := (result->>'capturedAmount')::NUMERIC;
  released := (result->>'releasedAmount')::NUMERIC;
  IF context->>'rootState'<>'open' OR context->>'holdState'<>'open'
    OR context#>>'{allocation,state}'<>'active'
    OR budget->>'executionManifestRef'<>context#>>'{sourceBudget,executionManifestRef}'
    OR (budget->>'rootAllocationRevision')::BIGINT<>
      (context#>>'{sourceBudget,rootAllocationRevision}')::BIGINT
    OR (budget->>'rootAllocationEpoch')::BIGINT<>
      (context#>>'{sourceBudget,rootAllocationEpoch}')::BIGINT
    OR (budget->>'authorizationSegmentVersion')::BIGINT<>
      (context#>>'{sourceBudget,authorizationSegmentVersion}')::BIGINT
    OR (budget->>'reservedCeiling')::NUMERIC<>
      (context#>>'{sourceBudget,reservedCeiling}')::NUMERIC
    OR budget->>'unit'<>context#>>'{sourceBudget,unit}'
    OR result->>'rootState'<>'settled'
    OR result->>'holdState' IS DISTINCT FROM
      (CASE WHEN captured=0 THEN 'released' ELSE 'settled' END)
    OR (result->>'rootVersion')::BIGINT<>(context->>'rootVersion')::BIGINT+1
    OR (result->>'holdFenceEpoch')::BIGINT<>(context->>'holdFenceEpoch')::BIGINT+1
    OR (allocation->>'revision')::BIGINT<>(context#>>'{allocation,revision}')::BIGINT+1
    OR (allocation->>'allocationEpoch')::BIGINT<>(context#>>'{allocation,allocationEpoch}')::BIGINT+1
    OR (allocation->>'creditCeiling')::NUMERIC<>(context#>>'{allocation,creditCeiling}')::NUMERIC
    OR (allocation->>'unassignedStock')::NUMERIC<>0
    OR (allocation->>'activeChildReservedStock')::NUMERIC<>0
    OR (allocation->>'committedStock')::NUMERIC<>0
    OR (allocation->>'capturedCumulative')::NUMERIC<>captured
    OR (allocation->>'returnedToParentCumulative')::NUMERIC<>
      (context#>>'{allocation,returnedToParentCumulative}')::NUMERIC+released
    OR allocation->>'state'<>'terminal'
    OR (context->>'openChildCount')::BIGINT<>0 OR (context->>'openSegmentCount')::BIGINT<>0
    OR (context->>'openAttemptCount')::BIGINT<>0
    OR captured<>(context->>'holdCapturedAmount')::NUMERIC
    OR captured<>(context#>>'{allocation,capturedCumulative}')::NUMERIC
    OR captured<>(context#>>'{settlement,customerAmount}')::NUMERIC
    OR released<>(context#>>'{allocation,unassignedStock}')::NUMERIC
    OR captured+released<>(context->>'holdReservedAmount')::NUMERIC
    OR settlement->>'authorizationSegmentRef'<>context#>>'{settlement,authorizationSegmentRef}'
    OR settlement->>'closureRef'<>context#>>'{settlement,closureRef}'
    OR (settlement->>'closureRevision')::BIGINT<>(context#>>'{settlement,closureRevision}')::BIGINT
    OR (settlement->>'customerAmount')::NUMERIC<>(context#>>'{settlement,customerAmount}')::NUMERIC
    OR (settlement->>'platformExposureAmount')::NUMERIC<>
      (context#>>'{settlement,platformExposureAmount}')::NUMERIC
    OR receipt->>'businessOperationKey'<>identity->>'businessOperationKey'
    OR receipt->>'requestDigest'<>identity->>'requestDigest'
    OR receipt->>'siteId'<>context->>'siteId'
    OR receipt->>'sourceKind'<>context->>'sourceKind'
    OR receipt->>'sourceRef'<>context->>'sourceRef'
    OR receipt->>'ownerProofDigest'<>owner_proof->>'proofDigest'
    OR receipt->>'terminalEvidenceRef'<>command->>'terminalEvidenceRef'
    OR receipt->>'outcome'<>command->>'outcome'
    OR receipt->>'executionManifestRef'<>budget->>'executionManifestRef'
    OR receipt->>'authorizationSegmentRef'<>budget->>'authorizationSegmentRef'
    OR (receipt->>'authorizationSegmentVersion')::BIGINT<>(budget->>'authorizationSegmentVersion')::BIGINT
    OR receipt->>'settlementRef'<>settlement->>'settlementRef'
    OR receipt->>'settlementClosureRef'<>settlement->>'closureRef'
    OR (receipt->>'settlementClosureRevision')::BIGINT<>(settlement->>'closureRevision')::BIGINT
    OR (receipt->>'platformExposureAmount')::NUMERIC<>(settlement->>'platformExposureAmount')::NUMERIC
    OR receipt->>'ratingSnapshotRef'<>context#>>'{settlement,ratingSnapshotRef}'
    OR receipt->>'executionBudgetRootRef'<>context->>'executionBudgetRootRef'
    OR receipt->>'rootAllocationRef'<>context->>'rootAllocationRef'
    OR receipt->>'rootHoldRef'<>context->>'creditHoldRef'
    OR (receipt->>'capturedAmount')::NUMERIC<>captured
    OR (receipt->>'releasedAmount')::NUMERIC<>released
    OR receipt->>'unit'<>context#>>'{settlement,unit}' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_COMMIT_FENCE_INVALID';
  END IF;
  expected_receipt_digest := platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
    'kokoro.platform.credit.execution-root.receipt.v1',receipt->>'allocationClosureReceiptRef',
    receipt->>'siteId',receipt->>'sourceKind',receipt->>'sourceRef',receipt->>'ownerProofDigest',
    receipt->>'businessOperationKey',receipt->>'requestDigest',receipt->>'terminalEvidenceRef',
    receipt->>'settlementRef',receipt->>'executionBudgetRootRef',
    receipt->>'rootAllocationRef',receipt->>'rootHoldRef',receipt->>'capturedAmount',
    receipt->>'releasedAmount',receipt->>'unit',receipt->>'outcome',receipt->>'executionManifestRef',
    receipt->>'authorizationSegmentRef',receipt->>'authorizationSegmentVersion',
    receipt->>'settlementClosureRef',receipt->>'settlementClosureRevision',
    receipt->>'platformExposureAmount',receipt->>'ratingSnapshotRef',receipt->>'recordedAt']);
  IF expected_receipt_digest IS DISTINCT FROM receipt->>'receiptDigest' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECEIPT_DIGEST_INVALID';
  END IF;
  SELECT count(*),count(DISTINCT (value->>'creditGrantId')::UUID),
         count(DISTINCT (value->>'ordinal')::INTEGER)
    INTO release_count,release_grant_count,release_ordinal_count
    FROM jsonb_array_elements(result->'releases');
  IF release_count<>release_grant_count OR release_count<>release_ordinal_count THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_SOURCE_DUPLICATE';
  END IF;
  SELECT COALESCE(sum(allocation_row.allocated_amount),0),
         COALESCE(sum(source_net.net_customer_amount),0)
    INTO source_allocated_total,source_captured_total
    FROM platform.credit_hold_allocation allocation_row
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
        THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS net_customer_amount
        FROM platform.credit_usage_settlement_source settlement_source
       WHERE settlement_source.credit_hold_ref=allocation_row.credit_hold_ref
         AND settlement_source.credit_grant_id=allocation_row.credit_grant_id
    ) source_net
   WHERE allocation_row.credit_hold_ref=(context->>'creditHoldRef')::UUID
     AND allocation_row.site_ref=context->>'siteId';
  IF source_allocated_total<>(context->>'holdReservedAmount')::NUMERIC
    OR source_captured_total<>captured THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_HOLD_SOURCE_TOTAL_INVALID';
  END IF;
  WITH availability AS (
    SELECT allocation_row.credit_grant_id,allocation_row.allocation_ordinal,
      allocation_row.allocated_amount-COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
        THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS available_amount
      FROM platform.credit_hold_allocation allocation_row
      LEFT JOIN platform.credit_usage_settlement_source settlement_source
        ON settlement_source.credit_hold_ref=allocation_row.credit_hold_ref
       AND settlement_source.credit_grant_id=allocation_row.credit_grant_id
     WHERE allocation_row.credit_hold_ref=(context->>'creditHoldRef')::UUID
       AND allocation_row.site_ref=context->>'siteId'
     GROUP BY allocation_row.credit_grant_id,allocation_row.allocation_ordinal,allocation_row.allocated_amount
  ), ordered AS (
    SELECT availability.*,
      COALESCE(sum(available_amount) OVER (ORDER BY allocation_ordinal
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS available_before
      FROM availability
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('creditGrantId',credit_grant_id::TEXT,
      'ordinal',allocation_ordinal,'amount',LEAST(available_amount,
        GREATEST(released-available_before,0))::TEXT) ORDER BY allocation_ordinal),'[]'::JSONB)
    INTO expected_releases FROM ordered
   WHERE available_amount>0 AND released-available_before>0;
  IF expected_releases IS DISTINCT FROM result->'releases' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_PLAN_INVALID';
  END IF;
  FOR release IN SELECT value FROM jsonb_array_elements(result->'releases') LOOP
    SELECT allocation_row.credit_grant_id,allocation_row.allocation_ordinal,
           allocation_row.allocated_amount,
           COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
             THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS net_customer_amount
      INTO STRICT source
      FROM platform.credit_hold_allocation allocation_row
      LEFT JOIN platform.credit_usage_settlement_source settlement_source
        ON settlement_source.credit_hold_ref=allocation_row.credit_hold_ref
       AND settlement_source.credit_grant_id=allocation_row.credit_grant_id
     WHERE allocation_row.credit_hold_ref=(context->>'creditHoldRef')::UUID
       AND allocation_row.site_ref=context->>'siteId'
       AND allocation_row.credit_grant_id=(release->>'creditGrantId')::UUID
       AND allocation_row.allocation_ordinal=(release->>'ordinal')::INTEGER
     GROUP BY allocation_row.credit_grant_id,allocation_row.allocation_ordinal,allocation_row.allocated_amount;
    IF (release->>'amount')::NUMERIC>source.allocated_amount-source.net_customer_amount THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_SOURCE_INVALID';
    END IF;
    release_total := release_total+(release->>'amount')::NUMERIC;
  END LOOP;
  IF release_total<>released
    OR (released=0 AND jsonb_array_length(result->'releases')<>0)
    OR (released=0)<>(result->>'releaseJournalTransactionRef' IS NULL)
    OR (released=0)<>(result->>'releaseEntriesDigest' IS NULL) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_TOTAL_INVALID';
  END IF;
  IF released>0 THEN
    SELECT encode(sha256(convert_to(string_agg(concat_ws('|',
      (((item.position-1)*2+side.entry_offset)::BIGINT)::TEXT,context->>'siteId',
      lower(context->>'creditAccountId'),context#>>'{settlement,unit}',side.entry_side,
      side.account_type,item.value->>'amount',lower((item.value->>'creditGrantId')::UUID::TEXT),
      lower(context->>'creditHoldRef')),E'\n' ORDER BY item.position,side.entry_offset),'UTF8')),'hex')
      INTO expected_release_digest
      FROM jsonb_array_elements(result->'releases') WITH ORDINALITY AS item(value,position)
      CROSS JOIN (VALUES (0,'debit','customer_reserved'),(1,'credit','customer_available'))
        AS side(entry_offset,entry_side,account_type);
    IF expected_release_digest IS DISTINCT FROM result->>'releaseEntriesDigest' THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_DIGEST_INVALID';
    END IF;
  END IF;
  IF (result->>'allocationRevisionRef')::UUID=(receipt->>'allocationClosureReceiptRef')::UUID THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECEIPT_IDENTITY_REUSED';
  END IF;

  INSERT INTO platform.credit_budget_allocation_revision(
    allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
    credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
    unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
    returned_to_parent_cumulative,state,terminal_receipt_digest)
  VALUES ((result->>'allocationRevisionRef')::UUID,(context->>'rootAllocationRef')::UUID,
    (context->>'executionBudgetRootRef')::UUID,context->>'siteId',context->>'billingAccountId',
    (context->>'creditAccountId')::UUID,context#>>'{settlement,unit}',context->>'liabilityMerchantAccountId',
    (allocation->>'revision')::BIGINT,(allocation->>'allocationEpoch')::BIGINT,
    (allocation->>'creditCeiling')::NUMERIC,0,0,0,captured,
    (allocation->>'returnedToParentCumulative')::NUMERIC,'terminal',receipt->>'receiptDigest');
  UPDATE platform.credit_budget_allocation SET current_revision=(allocation->>'revision')::BIGINT,
    current_allocation_epoch=(allocation->>'allocationEpoch')::BIGINT
   WHERE budget_allocation_ref=(context->>'rootAllocationRef')::UUID AND site_ref=context->>'siteId'
     AND current_revision=(context#>>'{allocation,revision}')::BIGINT
     AND current_allocation_epoch=(context#>>'{allocation,allocationEpoch}')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_ALLOCATION_CAS_LOST'; END IF;

  IF released>0 THEN
    release_ref := (result->>'releaseJournalTransactionRef')::UUID;
    INSERT INTO platform.credit_journal_transaction(
      journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
      operation_kind,expected_entry_count,entries_digest,occurred_at)
    VALUES (release_ref,(context->>'creditAccountId')::UUID,context->>'siteId',context#>>'{settlement,unit}',
      identity->>'businessOperationKey',identity->>'requestDigest','hold_release',
      jsonb_array_length(result->'releases')*2,result->>'releaseEntriesDigest',
      (receipt->>'recordedAt')::TIMESTAMPTZ);
    FOR release IN SELECT value FROM jsonb_array_elements(result->'releases') LOOP
      INSERT INTO platform.credit_journal_entry(journal_transaction_ref,entry_ordinal,site_ref,
        credit_account_ref,unit,entry_side,account_type,amount,credit_grant_id,credit_hold_ref)
      VALUES (release_ref,entry_ordinal,context->>'siteId',(context->>'creditAccountId')::UUID,
        context#>>'{settlement,unit}','debit','customer_reserved',(release->>'amount')::NUMERIC,
        (release->>'creditGrantId')::UUID,(context->>'creditHoldRef')::UUID);
      entry_ordinal := entry_ordinal+1;
      INSERT INTO platform.credit_journal_entry(journal_transaction_ref,entry_ordinal,site_ref,
        credit_account_ref,unit,entry_side,account_type,amount,credit_grant_id,credit_hold_ref)
      VALUES (release_ref,entry_ordinal,context->>'siteId',(context->>'creditAccountId')::UUID,
        context#>>'{settlement,unit}','credit','customer_available',(release->>'amount')::NUMERIC,
        (release->>'creditGrantId')::UUID,(context->>'creditHoldRef')::UUID);
      entry_ordinal := entry_ordinal+1;
    END LOOP;
  END IF;
  UPDATE platform.credit_hold SET released_amount=released_amount+released,
    state=CASE WHEN captured=0 THEN 'released' ELSE 'settled' END,
    resolution_kind='known_outcome',resolution_ref=receipt->>'allocationClosureReceiptRef',
    fence_epoch=(result->>'holdFenceEpoch')::BIGINT,
    settled_at=CASE WHEN captured>0 THEN (receipt->>'recordedAt')::TIMESTAMPTZ ELSE NULL END,
    released_at=CASE WHEN captured=0 THEN (receipt->>'recordedAt')::TIMESTAMPTZ ELSE NULL END,
    updated_at=(receipt->>'recordedAt')::TIMESTAMPTZ
   WHERE credit_hold_ref=(context->>'creditHoldRef')::UUID AND site_ref=context->>'siteId'
     AND state='open' AND fence_epoch=(context->>'holdFenceEpoch')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_HOLD_CAS_LOST'; END IF;
  UPDATE platform.credit_execution_budget_root SET state='settled',
    aggregate_version=(result->>'rootVersion')::BIGINT,updated_at=(receipt->>'recordedAt')::TIMESTAMPTZ
   WHERE execution_budget_root_ref=(context->>'executionBudgetRootRef')::UUID AND site_ref=context->>'siteId'
     AND state='open' AND aggregate_version=(context->>'rootVersion')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_ROOT_CAS_LOST'; END IF;
  INSERT INTO platform.credit_execution_root_outcome(site_ref,source_kind,source_ref,owner_proof_digest,
    business_operation_key,request_digest,outcome_kind,outcome_ref)
  VALUES (receipt->>'siteId',receipt->>'sourceKind',receipt->>'sourceRef',receipt->>'ownerProofDigest',
    receipt->>'businessOperationKey',receipt->>'requestDigest','closure',
    (receipt->>'allocationClosureReceiptRef')::UUID);
  INSERT INTO platform.credit_execution_root_closure_receipt(
    allocation_closure_receipt_ref,site_ref,source_kind,source_ref,owner_proof_digest,
    business_operation_key,request_digest,terminal_evidence_ref,outcome,
    execution_manifest_ref,authorization_segment_ref,
    authorization_segment_version,settlement_ref,settlement_closure_ref,settlement_closure_revision,
    platform_exposure_amount,rating_snapshot_ref,execution_budget_root_ref,root_allocation_ref,root_hold_ref,
    allocation_before_revision,allocation_after_revision,allocation_before_epoch,allocation_after_epoch,
    root_before_version,root_after_version,hold_before_fence,hold_after_fence,captured_amount,released_amount,
    reserved_ceiling,unit,release_journal_transaction_ref,receipt_digest,recorded_at)
  VALUES ((receipt->>'allocationClosureReceiptRef')::UUID,receipt->>'siteId',receipt->>'sourceKind',
    receipt->>'sourceRef',receipt->>'ownerProofDigest',receipt->>'businessOperationKey',
    receipt->>'requestDigest',receipt->>'terminalEvidenceRef',
    receipt->>'outcome',receipt->>'executionManifestRef',(receipt->>'authorizationSegmentRef')::UUID,
    (receipt->>'authorizationSegmentVersion')::BIGINT,(receipt->>'settlementRef')::UUID,
    (receipt->>'settlementClosureRef')::UUID,(receipt->>'settlementClosureRevision')::BIGINT,
    (receipt->>'platformExposureAmount')::NUMERIC,(receipt->>'ratingSnapshotRef')::UUID,
    (receipt->>'executionBudgetRootRef')::UUID,(receipt->>'rootAllocationRef')::UUID,
    (receipt->>'rootHoldRef')::UUID,(context#>>'{allocation,revision}')::BIGINT,
    (allocation->>'revision')::BIGINT,(context#>>'{allocation,allocationEpoch}')::BIGINT,
    (allocation->>'allocationEpoch')::BIGINT,(context->>'rootVersion')::BIGINT,
    (result->>'rootVersion')::BIGINT,(context->>'holdFenceEpoch')::BIGINT,
    (result->>'holdFenceEpoch')::BIGINT,captured,released,(context->>'holdReservedAmount')::NUMERIC,
    receipt->>'unit',release_ref,receipt->>'receiptDigest',(receipt->>'recordedAt')::TIMESTAMPTZ)
  RETURNING * INTO prior;
  RETURN jsonb_build_object('kind','accepted','value',platform.execution_root_closure_receipt_json(prior));
END $$;
REVOKE ALL ON FUNCTION platform.commit_execution_root_closure(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.commit_execution_root_closure(JSONB)
  TO platform_media_worker,platform_admission;

CREATE FUNCTION platform.mark_execution_root_reconciliation(p_record JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.credit_execution_root_reconciliation%ROWTYPE;
  outcome_prior platform.credit_execution_root_outcome%ROWTYPE;
  identity JSONB; owner_proof JSONB; command JSONB; budget JSONB; settlement JSONB;
  authority JSONB; result JSONB; context JSONB; expected_request_digest CHAR(64);
  authority_mismatch BOOLEAN; rating_mismatch BOOLEAN; source_mismatch BOOLEAN;
  source_allocated NUMERIC(38,0); source_captured NUMERIC(38,0);
BEGIN
  IF octet_length(p_record::TEXT)>65536
    OR NOT platform.credit_direct_root_json_exact_keys(p_record,ARRAY['identity','command','authority','result'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'identity',
      ARRAY['siteId','ownerProof','businessOperationKey','requestDigest'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'command',
      ARRAY['terminalEvidenceRef','outcome','budget','settlement'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{command,budget}',ARRAY[
      'executionBudgetRootRef','executionManifestRef','rootHoldRef','rootAllocationRef',
      'rootAllocationRevision','rootAllocationEpoch','authorizationSegmentRef',
      'authorizationSegmentVersion','reservedCeiling','unit'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record#>'{command,settlement}',ARRAY[
      'settlementRef','authorizationSegmentRef','closureRef','closureRevision','state',
      'customerAmount','platformExposureAmount'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'authority',ARRAY[
      'executionBudgetRootRef','rootAllocationRef','rootHoldRef','authorizationSegmentRef','settlementRef',
      'executionManifestRef','rootAllocationRevision','rootAllocationEpoch','authorizationSegmentVersion',
      'reservedCeiling','unit','expectedRootState','expectedRootVersion','expectedHoldState',
      'expectedHoldFenceEpoch','expectedAllocationState','expectedAllocationRevision','expectedAllocationEpoch'])
    OR NOT platform.credit_direct_root_json_exact_keys(p_record->'result',ARRAY[
      'reconciliationReceiptRef','reconciliationAllocationRevisionRef','code','observedAt']) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_SHAPE_INVALID';
  END IF;
  IF NOT platform.credit_direct_root_reconciliation_values_canonical(p_record) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_CANONICAL_VALUE_INVALID';
  END IF;
  identity := p_record->'identity'; owner_proof := identity->'ownerProof'; command := p_record->'command';
  budget := command->'budget'; settlement := command->'settlement'; authority := p_record->'authority';
  result := p_record->'result';
  IF identity->>'requestDigest' !~ '^[a-f0-9]{64}$'
    OR owner_proof->>'proofDigest' !~ '^[a-f0-9]{64}$'
    OR command->>'outcome' NOT IN ('completed','partial','failed','canceled')
    OR command->>'outcome' IS DISTINCT FROM owner_proof->>'outcome'
    OR command->>'terminalEvidenceRef' IS DISTINCT FROM owner_proof->>'terminalEvidenceRef'
    OR settlement->>'state'<>'settled'
    OR result->>'code' NOT IN ('CREDIT_EXECUTION_ROOT_SOURCE_AUTHORITY_MISMATCH',
      'CREDIT_EXECUTION_ROOT_RATING_MISMATCH','CREDIT_EXECUTION_ROOT_HOLD_SOURCE_MISMATCH') THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_VALUE_INVALID';
  END IF;
  IF result->>'observedAt' !~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_TIMESTAMP_INVALID';
  END IF;
  IF to_char((result->>'observedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM result->>'observedAt' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_TIMESTAMP_INVALID';
  END IF;
  PERFORM platform.assert_execution_root_owner_proof(identity->>'siteId',owner_proof);
  PERFORM platform.credit_direct_root_lock_outcome(
    identity->>'siteId',owner_proof->>'kind',owner_proof->>'sourceRef',identity->>'businessOperationKey');
  expected_request_digest := platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
    'kokoro.platform.credit.execution-root.request.v1',identity->>'siteId',owner_proof->>'kind',
    owner_proof->>'sourceRef',owner_proof->>'terminalEvidenceRef',owner_proof->>'outcome',
    owner_proof->>'proofDigest',
    budget->>'executionBudgetRootRef',budget->>'executionManifestRef',budget->>'rootHoldRef',
    budget->>'rootAllocationRef',budget->>'rootAllocationRevision',budget->>'rootAllocationEpoch',
    budget->>'authorizationSegmentRef',budget->>'authorizationSegmentVersion',
    budget->>'reservedCeiling',budget->>'unit',settlement->>'settlementRef',
    settlement->>'authorizationSegmentRef',settlement->>'closureRef',
    settlement->>'closureRevision',settlement->>'state',settlement->>'customerAmount',
    settlement->>'platformExposureAmount']);
  IF expected_request_digest IS DISTINCT FROM identity->>'requestDigest' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_REQUEST_DIGEST_INVALID';
  END IF;
  SELECT * INTO outcome_prior FROM platform.credit_execution_root_outcome
   WHERE site_ref=identity->>'siteId'
     AND (business_operation_key=identity->>'businessOperationKey'
       OR (source_kind=owner_proof->>'kind' AND source_ref=owner_proof->>'sourceRef')) FOR UPDATE;
  IF FOUND THEN
    IF outcome_prior.business_operation_key IS DISTINCT FROM identity->>'businessOperationKey'
      OR outcome_prior.source_kind IS DISTINCT FROM owner_proof->>'kind'
      OR outcome_prior.source_ref IS DISTINCT FROM owner_proof->>'sourceRef'
      OR outcome_prior.owner_proof_digest IS DISTINCT FROM owner_proof->>'proofDigest'
      OR outcome_prior.request_digest IS DISTINCT FROM identity->>'requestDigest'
      OR outcome_prior.outcome_kind IS DISTINCT FROM 'reconciliation' THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_CONFLICT';
    END IF;
    SELECT * INTO STRICT prior FROM platform.credit_execution_root_reconciliation
     WHERE site_ref=identity->>'siteId' AND reconciliation_receipt_ref=outcome_prior.outcome_ref;
    IF prior.code IS DISTINCT FROM result->>'code' THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_CONFLICT';
    END IF;
    RETURN jsonb_build_object('kind','replayed');
  END IF;
  context := platform.lock_execution_root_closure(
    identity->>'siteId',owner_proof,identity->>'businessOperationKey',(authority->>'executionBudgetRootRef')::UUID,
    (authority->>'rootAllocationRef')::UUID,(authority->>'rootHoldRef')::UUID,
    (authority->>'authorizationSegmentRef')::UUID,(authority->>'settlementRef')::UUID,
    authority->>'executionManifestRef',(authority->>'rootAllocationRevision')::BIGINT,
    (authority->>'rootAllocationEpoch')::BIGINT,(authority->>'authorizationSegmentVersion')::BIGINT,
    (authority->>'reservedCeiling')::NUMERIC,authority->>'unit');
  IF context IS NULL THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_CONTEXT_NOT_FOUND'; END IF;
  IF context->>'rootState' NOT IN ('open','closing')
    OR context->>'holdState' NOT IN ('open','closing')
    OR context#>>'{allocation,state}' NOT IN ('active','returning') THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_TERMINAL_REGRESSION';
  END IF;
  IF authority->>'expectedRootState'<>context->>'rootState'
    OR identity->>'siteId'<>context->>'siteId'
    OR owner_proof->>'kind'<>context->>'sourceKind'
    OR owner_proof->>'sourceRef'<>context->>'sourceRef'
    OR authority->>'executionBudgetRootRef'<>context->>'executionBudgetRootRef'
    OR authority->>'rootAllocationRef'<>context->>'rootAllocationRef'
    OR authority->>'rootHoldRef'<>context->>'creditHoldRef'
    OR authority->>'authorizationSegmentRef'<>context#>>'{settlement,authorizationSegmentRef}'
    OR authority->>'settlementRef'<>context#>>'{settlement,settlementRef}'
    OR authority->>'executionManifestRef'<>context#>>'{sourceBudget,executionManifestRef}'
    OR (authority->>'rootAllocationRevision')::BIGINT<>
      (context#>>'{sourceBudget,rootAllocationRevision}')::BIGINT
    OR (authority->>'rootAllocationEpoch')::BIGINT<>
      (context#>>'{sourceBudget,rootAllocationEpoch}')::BIGINT
    OR (authority->>'authorizationSegmentVersion')::BIGINT<>
      (context#>>'{sourceBudget,authorizationSegmentVersion}')::BIGINT
    OR (authority->>'reservedCeiling')::NUMERIC<>
      (context#>>'{sourceBudget,reservedCeiling}')::NUMERIC
    OR authority->>'unit'<>context#>>'{sourceBudget,unit}'
    OR (authority->>'expectedRootVersion')::BIGINT<>(context->>'rootVersion')::BIGINT
    OR authority->>'expectedHoldState'<>context->>'holdState'
    OR (authority->>'expectedHoldFenceEpoch')::BIGINT<>(context->>'holdFenceEpoch')::BIGINT
    OR authority->>'expectedAllocationState'<>context#>>'{allocation,state}'
    OR (authority->>'expectedAllocationRevision')::BIGINT<>(context#>>'{allocation,revision}')::BIGINT
    OR (authority->>'expectedAllocationEpoch')::BIGINT<>(context#>>'{allocation,allocationEpoch}')::BIGINT
    OR (result->>'reconciliationReceiptRef')::UUID=
      (result->>'reconciliationAllocationRevisionRef')::UUID THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_FENCE_INVALID';
  END IF;
  authority_mismatch :=
    budget->>'executionBudgetRootRef' IS DISTINCT FROM context->>'executionBudgetRootRef'
    OR budget->>'rootAllocationRef' IS DISTINCT FROM context->>'rootAllocationRef'
    OR budget->>'rootHoldRef' IS DISTINCT FROM context->>'creditHoldRef'
    OR budget->>'authorizationSegmentRef' IS DISTINCT FROM context#>>'{settlement,authorizationSegmentRef}'
    OR budget->>'executionManifestRef' IS DISTINCT FROM context#>>'{sourceBudget,executionManifestRef}'
    OR (budget->>'rootAllocationRevision')::BIGINT IS DISTINCT FROM
      (context#>>'{sourceBudget,rootAllocationRevision}')::BIGINT
    OR (budget->>'rootAllocationEpoch')::BIGINT IS DISTINCT FROM
      (context#>>'{sourceBudget,rootAllocationEpoch}')::BIGINT
    OR (budget->>'authorizationSegmentVersion')::BIGINT IS DISTINCT FROM
      (context#>>'{sourceBudget,authorizationSegmentVersion}')::BIGINT
    OR (budget->>'reservedCeiling')::NUMERIC IS DISTINCT FROM
      (context#>>'{sourceBudget,reservedCeiling}')::NUMERIC
    OR budget->>'unit' IS DISTINCT FROM context#>>'{sourceBudget,unit}'
    OR settlement->>'settlementRef' IS DISTINCT FROM context#>>'{settlement,settlementRef}'
    OR settlement->>'authorizationSegmentRef' IS DISTINCT FROM
      context#>>'{settlement,authorizationSegmentRef}'
    OR settlement->>'closureRef' IS DISTINCT FROM context#>>'{settlement,closureRef}'
    OR (settlement->>'closureRevision')::BIGINT IS DISTINCT FROM
      (context#>>'{settlement,closureRevision}')::BIGINT
    OR (settlement->>'customerAmount')::NUMERIC IS DISTINCT FROM
      (context#>>'{settlement,customerAmount}')::NUMERIC
    OR (settlement->>'platformExposureAmount')::NUMERIC IS DISTINCT FROM
      (context#>>'{settlement,platformExposureAmount}')::NUMERIC;
  rating_mismatch :=
    (context#>>'{allocation,capturedCumulative}')::NUMERIC IS DISTINCT FROM
      (context#>>'{settlement,customerAmount}')::NUMERIC
    OR (context#>>'{allocation,capturedCumulative}')::NUMERIC IS DISTINCT FROM
      (context->>'holdCapturedAmount')::NUMERIC
    OR (context#>>'{allocation,capturedCumulative}')::NUMERIC+
      (context#>>'{allocation,unassignedStock}')::NUMERIC IS DISTINCT FROM
      (context#>>'{sourceBudget,reservedCeiling}')::NUMERIC
    OR (context->>'holdCapturedAmount')::NUMERIC+(context->>'holdReleasedAmount')::NUMERIC+
      (context#>>'{allocation,unassignedStock}')::NUMERIC IS DISTINCT FROM
      (context->>'holdReservedAmount')::NUMERIC;
  SELECT COALESCE(sum((value->>'allocatedAmount')::NUMERIC),0),
         COALESCE(sum((value->>'netCustomerAmount')::NUMERIC),0),
         COALESCE(bool_or((value->>'netCustomerAmount')::NUMERIC<0 OR
           (value->>'netCustomerAmount')::NUMERIC>(value->>'allocatedAmount')::NUMERIC),FALSE)
    INTO source_allocated,source_captured,source_mismatch
    FROM jsonb_array_elements(context->'holdAllocations');
  source_mismatch := source_mismatch
    OR source_allocated IS DISTINCT FROM (context->>'holdReservedAmount')::NUMERIC
    OR source_captured IS DISTINCT FROM (context#>>'{allocation,capturedCumulative}')::NUMERIC;
  IF (result->>'code'='CREDIT_EXECUTION_ROOT_SOURCE_AUTHORITY_MISMATCH' AND authority_mismatch IS NOT TRUE)
    OR (result->>'code'='CREDIT_EXECUTION_ROOT_RATING_MISMATCH' AND rating_mismatch IS NOT TRUE)
    OR (result->>'code'='CREDIT_EXECUTION_ROOT_HOLD_SOURCE_MISMATCH' AND source_mismatch IS NOT TRUE) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_EVIDENCE_INVALID';
  END IF;
  INSERT INTO platform.credit_budget_allocation_revision(
    allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
    credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
    unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
    returned_to_parent_cumulative,state)
  VALUES ((result->>'reconciliationAllocationRevisionRef')::UUID,(context->>'rootAllocationRef')::UUID,
    (context->>'executionBudgetRootRef')::UUID,context->>'siteId',context->>'billingAccountId',
    (context->>'creditAccountId')::UUID,context#>>'{settlement,unit}',context->>'liabilityMerchantAccountId',
    (context#>>'{allocation,revision}')::BIGINT+1,(context#>>'{allocation,allocationEpoch}')::BIGINT+1,
    (context#>>'{allocation,creditCeiling}')::NUMERIC,(context#>>'{allocation,unassignedStock}')::NUMERIC,
    (context#>>'{allocation,activeChildReservedStock}')::NUMERIC,
    (context#>>'{allocation,committedStock}')::NUMERIC,(context#>>'{allocation,capturedCumulative}')::NUMERIC,
    (context#>>'{allocation,returnedToParentCumulative}')::NUMERIC,'reconciliation_required');
  UPDATE platform.credit_budget_allocation SET current_revision=current_revision+1,
    current_allocation_epoch=current_allocation_epoch+1
   WHERE budget_allocation_ref=(context->>'rootAllocationRef')::UUID AND site_ref=context->>'siteId'
     AND current_revision=(context#>>'{allocation,revision}')::BIGINT
     AND current_allocation_epoch=(context#>>'{allocation,allocationEpoch}')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_ALLOCATION_CAS_LOST'; END IF;
  UPDATE platform.credit_execution_budget_root SET state='reconciliation_required',
    aggregate_version=aggregate_version+1,updated_at=(result->>'observedAt')::TIMESTAMPTZ
   WHERE execution_budget_root_ref=(context->>'executionBudgetRootRef')::UUID
     AND site_ref=context->>'siteId' AND state=authority->>'expectedRootState'
     AND aggregate_version=(authority->>'expectedRootVersion')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_ROOT_CAS_LOST'; END IF;
  UPDATE platform.credit_hold SET state='reconciliation_required',fence_epoch=fence_epoch+1,
    updated_at=(result->>'observedAt')::TIMESTAMPTZ
   WHERE credit_hold_ref=(context->>'creditHoldRef')::UUID AND site_ref=context->>'siteId'
     AND state=authority->>'expectedHoldState'
     AND fence_epoch=(authority->>'expectedHoldFenceEpoch')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_HOLD_CAS_LOST'; END IF;
  INSERT INTO platform.credit_execution_root_outcome(site_ref,source_kind,source_ref,owner_proof_digest,
    business_operation_key,request_digest,outcome_kind,outcome_ref)
  VALUES (context->>'siteId',context->>'sourceKind',context->>'sourceRef',owner_proof->>'proofDigest',
    identity->>'businessOperationKey',identity->>'requestDigest','reconciliation',
    (result->>'reconciliationReceiptRef')::UUID);
  INSERT INTO platform.credit_execution_root_reconciliation(
    reconciliation_receipt_ref,reconciliation_allocation_revision_ref,site_ref,
    source_kind,source_ref,owner_proof_digest,terminal_evidence_ref,
    execution_budget_root_ref,root_allocation_ref,root_hold_ref,
    allocation_before_revision,allocation_after_revision,allocation_before_epoch,allocation_after_epoch,
    root_before_version,root_after_version,hold_before_fence,hold_after_fence,
    business_operation_key,request_digest,code,observed_at)
  VALUES ((result->>'reconciliationReceiptRef')::UUID,
    (result->>'reconciliationAllocationRevisionRef')::UUID,context->>'siteId',
    context->>'sourceKind',context->>'sourceRef',owner_proof->>'proofDigest',
    owner_proof->>'terminalEvidenceRef',
    (context->>'executionBudgetRootRef')::UUID,(context->>'rootAllocationRef')::UUID,
    (context->>'creditHoldRef')::UUID,(context#>>'{allocation,revision}')::BIGINT,
    (context#>>'{allocation,revision}')::BIGINT+1,(context#>>'{allocation,allocationEpoch}')::BIGINT,
    (context#>>'{allocation,allocationEpoch}')::BIGINT+1,(context->>'rootVersion')::BIGINT,
    (context->>'rootVersion')::BIGINT+1,(context->>'holdFenceEpoch')::BIGINT,
    (context->>'holdFenceEpoch')::BIGINT+1,identity->>'businessOperationKey',identity->>'requestDigest',
    result->>'code',(result->>'observedAt')::TIMESTAMPTZ);
  RETURN jsonb_build_object('kind','accepted');
END $$;
REVOKE ALL ON FUNCTION platform.mark_execution_root_reconciliation(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.mark_execution_root_reconciliation(JSONB)
  TO platform_media_worker,platform_admission;

GRANT USAGE ON SCHEMA platform TO platform_media_worker;
GRANT USAGE ON SCHEMA platform TO platform_admission;
REVOKE CREATE ON SCHEMA platform FROM platform_media_worker;
REVOKE CREATE ON SCHEMA platform FROM platform_admission;
