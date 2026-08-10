SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Upgrade already-migrated databases without rewriting the immutable closure source migration.
-- Allocation revision INSERT owns its head CAS. Direct terminal state edges are admitted only
-- while the exact SECURITY DEFINER closure routine holds a transaction-local marker.

CREATE OR REPLACE FUNCTION platform.credit_direct_root_lock_outcome(
  p_site_ref TEXT,p_source_kind TEXT,p_source_ref TEXT,p_business_operation_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE source_lock BIGINT; business_lock BIGINT;
BEGIN
  source_lock := hashtextextended(platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
    'kokoro.credit.execution-root.source.v1',p_site_ref,p_source_kind,p_source_ref])::TEXT,0);
  business_lock := hashtextextended(platform.credit_direct_root_framed_digest(VARIADIC ARRAY[
    'kokoro.credit.execution-root.business.v1',p_site_ref,p_business_operation_key])::TEXT,0);
  PERFORM pg_advisory_xact_lock(LEAST(source_lock,business_lock));
  IF source_lock<>business_lock THEN
    PERFORM pg_advisory_xact_lock(GREATEST(source_lock,business_lock));
  END IF;
END $$;

REVOKE ALL ON FUNCTION platform.credit_direct_root_lock_outcome(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.guard_credit_execution_budget_root_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE relation_owner NAME;
BEGIN
  IF ROW(OLD.execution_budget_root_ref,OLD.site_ref,OLD.execution_root_ref,OLD.billing_account_ref,
         OLD.credit_account_ref,OLD.unit,OLD.liability_merchant_account_ref,OLD.credit_hold_ref,
         OLD.root_allocation_ref,OLD.authorization_budget_ref,OLD.rating_policy_revision_ref,
         OLD.surface_ref,OLD.capability_key,OLD.agent_ref,OLD.reserved_ceiling,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.execution_budget_root_ref,NEW.site_ref,NEW.execution_root_ref,NEW.billing_account_ref,
         NEW.credit_account_ref,NEW.unit,NEW.liability_merchant_account_ref,NEW.credit_hold_ref,
         NEW.root_allocation_ref,NEW.authorization_budget_ref,NEW.rating_policy_revision_ref,
         NEW.surface_ref,NEW.capability_key,NEW.agent_ref,NEW.reserved_ceiling,NEW.created_at)
     OR NEW.aggregate_version<>OLD.aggregate_version+1 THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_BUDGET_ROOT_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  SELECT pg_get_userbyid(relation.relowner) INTO relation_owner
    FROM pg_catalog.pg_class relation WHERE relation.oid=TG_RELID;
  IF OLD.state='settled'
     OR (OLD.state='open' AND NEW.state NOT IN ('closing','settled','reconciliation_required'))
     OR (OLD.state='open' AND NEW.state='settled' AND (
       current_setting('app.credit_execution_root_closure_transition',true) IS DISTINCT FROM 'commit'
       OR CURRENT_USER=SESSION_USER OR CURRENT_USER IS DISTINCT FROM relation_owner))
     OR (OLD.state='closing' AND NEW.state NOT IN ('settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state NOT IN ('closing','settled')) THEN
    RAISE EXCEPTION 'CREDIT_EXECUTION_BUDGET_ROOT_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION platform.guard_credit_execution_budget_root_transition() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.guard_credit_hold_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE relation_owner NAME;
BEGIN
  IF ROW(OLD.credit_hold_ref,OLD.credit_account_ref,OLD.site_ref,OLD.execution_root_ref,
         OLD.unit,OLD.requested_amount,OLD.reserved_amount,OLD.expires_at,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.credit_hold_ref,NEW.credit_account_ref,NEW.site_ref,NEW.execution_root_ref,
         NEW.unit,NEW.requested_amount,NEW.reserved_amount,NEW.expires_at,NEW.created_at)
     OR NEW.fence_epoch<>OLD.fence_epoch+1 THEN
    RAISE EXCEPTION 'CREDIT_HOLD_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  SELECT pg_get_userbyid(relation.relowner) INTO relation_owner
    FROM pg_catalog.pg_class relation WHERE relation.oid=TG_RELID;
  IF NEW.captured_amount<OLD.captured_amount OR NEW.released_amount<OLD.released_amount
     OR OLD.state IN ('settled','released','expired')
     OR (OLD.state='open' AND NEW.state NOT IN ('open','closing','settled','released','expired','reconciliation_required'))
     OR (OLD.state='open' AND NEW.state='settled' AND (
       current_setting('app.credit_execution_root_closure_transition',true) IS DISTINCT FROM 'commit'
       OR CURRENT_USER=SESSION_USER OR CURRENT_USER IS DISTINCT FROM relation_owner))
     OR (OLD.state='closing' AND NEW.state NOT IN ('closing','settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state NOT IN ('reconciliation_required','closing','settled')) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.state IN ('released','expired') THEN
    IF NEW.state='expired' AND (NEW.resolution_kind<>'reservation_expiry' OR now()<OLD.expires_at) THEN
      RAISE EXCEPTION 'CREDIT_HOLD_TTL_RELEASE_INVALID' USING ERRCODE='23514';
    ELSIF NEW.state='released' AND NEW.resolution_kind<>'known_outcome' THEN
      RAISE EXCEPTION 'CREDIT_HOLD_RELEASE_EVIDENCE_REQUIRED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION platform.guard_credit_hold_transition() FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.commit_execution_root_closure(p_record JSONB) RETURNS JSONB
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
    SELECT encode(sha256(convert_to(string_agg(
      octet_length(posting.ordinal)::TEXT||':'||posting.ordinal||
      octet_length(posting.site_ref)::TEXT||':'||posting.site_ref||
      octet_length(posting.credit_account_ref)::TEXT||':'||posting.credit_account_ref||
      octet_length(posting.unit)::TEXT||':'||posting.unit||
      octet_length(posting.entry_side)::TEXT||':'||posting.entry_side||
      octet_length(posting.account_type)::TEXT||':'||posting.account_type||
      octet_length(posting.amount)::TEXT||':'||posting.amount||
      octet_length(posting.credit_grant_id)::TEXT||':'||posting.credit_grant_id||
      octet_length(posting.credit_hold_ref)::TEXT||':'||posting.credit_hold_ref,
      '' ORDER BY item.position,side.entry_offset),'UTF8')),'hex')
      INTO expected_release_digest
      FROM jsonb_array_elements(result->'releases') WITH ORDINALITY AS item(value,position)
      CROSS JOIN (VALUES (0,'debit','customer_reserved'),(1,'credit','customer_available'))
        AS side(entry_offset,entry_side,account_type)
      CROSS JOIN LATERAL (SELECT
        (((item.position-1)*2+side.entry_offset)::BIGINT)::TEXT AS ordinal,
        context->>'siteId' AS site_ref,lower(context->>'creditAccountId') AS credit_account_ref,
        context#>>'{settlement,unit}' AS unit,side.entry_side,side.account_type,
        item.value->>'amount' AS amount,
        lower((item.value->>'creditGrantId')::UUID::TEXT) AS credit_grant_id,
        lower(context->>'creditHoldRef') AS credit_hold_ref
      ) posting;
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
  PERFORM set_config('app.credit_execution_root_closure_transition','commit',true);
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
  PERFORM set_config('app.credit_execution_root_closure_transition','',true);
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

CREATE OR REPLACE FUNCTION platform.mark_execution_root_reconciliation(p_record JSONB) RETURNS JSONB
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
