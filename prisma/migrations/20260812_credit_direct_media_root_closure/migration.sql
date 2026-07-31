SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.credit_direct_media_root_closure_receipt (
  allocation_closure_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  media_operation_ref TEXT NOT NULL CHECK(length(media_operation_ref) BETWEEN 1 AND 256),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  effect_closure_receipt_ref TEXT NOT NULL CHECK(length(effect_closure_receipt_ref) BETWEEN 1 AND 256),
  settlement_ref UUID NOT NULL,
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
  UNIQUE(site_ref,media_operation_ref),
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
  FOREIGN KEY(settlement_ref,site_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref),
  FOREIGN KEY(rating_snapshot_ref,site_ref)
    REFERENCES platform.credit_rating_snapshot(rating_snapshot_ref,site_ref),
  FOREIGN KEY(release_journal_transaction_ref,site_ref)
    REFERENCES platform.credit_journal_transaction(journal_transaction_ref,site_ref),
  CHECK(captured_amount+released_amount=reserved_ceiling),
  CHECK((released_amount=0)=(release_journal_transaction_ref IS NULL))
);

CREATE TABLE platform.credit_direct_media_root_reconciliation (
  reconciliation_receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  media_operation_ref TEXT NOT NULL CHECK(length(media_operation_ref) BETWEEN 1 AND 256),
  execution_budget_root_ref UUID NOT NULL,
  root_allocation_ref UUID NOT NULL,
  root_hold_ref UUID NOT NULL,
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 256),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,business_operation_key),
  UNIQUE(site_ref,media_operation_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(root_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(root_hold_ref,site_ref)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref)
);

ALTER TABLE platform.credit_direct_media_root_closure_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_direct_media_root_closure_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_direct_media_root_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.credit_direct_media_root_reconciliation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE platform.credit_direct_media_root_closure_receipt,
  platform.credit_direct_media_root_reconciliation FROM PUBLIC;
CREATE POLICY credit_direct_root_closure_definer
  ON platform.credit_direct_media_root_closure_receipt TO platform_migrator
  USING(SESSION_USER='platform_media_worker') WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY credit_direct_root_reconciliation_definer
  ON platform.credit_direct_media_root_reconciliation TO platform_migrator
  USING(SESSION_USER='platform_media_worker') WITH CHECK(SESSION_USER='platform_media_worker');

CREATE FUNCTION platform.reject_credit_direct_media_root_fact_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_DIRECT_MEDIA_ROOT_FACT_IMMUTABLE' USING ERRCODE='23000';
END $$;
CREATE TRIGGER credit_direct_media_root_closure_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_direct_media_root_closure_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_direct_media_root_fact_mutation();
CREATE TRIGGER credit_direct_media_root_reconciliation_immutable
  BEFORE UPDATE OR DELETE ON platform.credit_direct_media_root_reconciliation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_direct_media_root_fact_mutation();
REVOKE ALL ON FUNCTION platform.reject_credit_direct_media_root_fact_mutation() FROM PUBLIC;

CREATE FUNCTION platform.direct_media_root_closure_receipt_json(
  receipt platform.credit_direct_media_root_closure_receipt
) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,platform AS $$
  SELECT jsonb_build_object(
    'allocationClosureReceiptRef',receipt.allocation_closure_receipt_ref::TEXT,
    'siteId',receipt.site_ref,'operationRef',receipt.media_operation_ref,
    'businessOperationKey',receipt.business_operation_key,'requestDigest',receipt.request_digest,
    'effectClosureReceiptRef',receipt.effect_closure_receipt_ref,
    'settlementRef',receipt.settlement_ref::TEXT,
    'executionBudgetRootRef',receipt.execution_budget_root_ref::TEXT,
    'rootAllocationRef',receipt.root_allocation_ref::TEXT,'rootHoldRef',receipt.root_hold_ref::TEXT,
    'capturedAmount',receipt.captured_amount::TEXT,'releasedAmount',receipt.released_amount::TEXT,
    'unit',receipt.unit,'receiptDigest',receipt.receipt_digest,
    'recordedAt',receipt.recorded_at::TEXT)
$$;
REVOKE ALL ON FUNCTION platform.direct_media_root_closure_receipt_json(
  platform.credit_direct_media_root_closure_receipt) FROM PUBLIC;

CREATE FUNCTION platform.find_direct_media_root_closure(
  p_site_ref TEXT,p_media_operation_ref TEXT,p_business_operation_key TEXT,p_request_digest CHAR(64)
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.credit_direct_media_root_closure_receipt%ROWTYPE;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  SELECT * INTO prior FROM platform.credit_direct_media_root_closure_receipt
   WHERE site_ref=p_site_ref
     AND (business_operation_key=p_business_operation_key OR media_operation_ref=p_media_operation_ref);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','none'); END IF;
  IF prior.business_operation_key<>p_business_operation_key OR prior.media_operation_ref<>p_media_operation_ref
    OR prior.request_digest<>p_request_digest THEN RETURN jsonb_build_object('kind','conflict'); END IF;
  RETURN jsonb_build_object('kind','replayed','value',platform.direct_media_root_closure_receipt_json(prior));
END $$;
REVOKE ALL ON FUNCTION platform.find_direct_media_root_closure(TEXT,TEXT,TEXT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.find_direct_media_root_closure(TEXT,TEXT,TEXT,CHAR) TO platform_media_worker;

CREATE FUNCTION platform.lock_direct_media_root_closure(
  p_site_ref TEXT,p_operation_ref TEXT,p_execution_budget_root_ref UUID,
  p_root_allocation_ref UUID,p_root_hold_ref UUID,p_authorization_segment_ref UUID,p_settlement_ref UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE context RECORD; sources JSONB; open_children BIGINT; open_segments BIGINT; open_attempts BIGINT;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  SELECT root.state AS root_state,root.aggregate_version,root.billing_account_ref,
         root.credit_account_ref,root.liability_merchant_account_ref,
         hold.state AS hold_state,hold.fence_epoch,hold.reserved_amount,hold.captured_amount,
         hold.released_amount,allocation.current_revision,allocation.current_allocation_epoch,
         revision.revision,revision.allocation_epoch,revision.credit_ceiling,revision.unassigned_stock,
         revision.active_child_reserved_stock,revision.committed_stock,revision.captured_cumulative,
         revision.returned_to_parent_cumulative,revision.state AS allocation_state,
         settlement.authorization_segment_ref,settlement.execution_budget_root_ref AS settlement_root_ref,
         settlement.budget_allocation_ref AS settlement_allocation_ref,
         settlement.credit_hold_ref AS settlement_hold_ref,settlement.unit AS settlement_unit,
         settlement.customer_amount,settlement.rating_snapshot_ref
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
    JOIN platform.credit_usage_settlement settlement
      ON settlement.settlement_ref=p_settlement_ref AND settlement.site_ref=root.site_ref
     AND settlement.authorization_segment_ref=segment.authorization_segment_ref
    JOIN platform.credit_rating_snapshot snapshot
      ON snapshot.rating_snapshot_ref=settlement.rating_snapshot_ref AND snapshot.site_ref=root.site_ref
     AND snapshot.authorization_segment_ref=segment.authorization_segment_ref
   WHERE root.site_ref=p_site_ref AND root.execution_budget_root_ref=p_execution_budget_root_ref
     AND root.execution_root_ref=p_operation_ref AND root.root_allocation_ref=p_root_allocation_ref
     AND root.credit_hold_ref=p_root_hold_ref AND allocation.is_root AND allocation.parent_allocation_ref IS NULL
     AND allocation.audience='root'
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
    'siteId',p_site_ref,'operationRef',p_operation_ref,
    'executionBudgetRootRef',p_execution_budget_root_ref::TEXT,
    'rootState',context.root_state,'rootVersion',context.aggregate_version::TEXT,
    'billingAccountId',context.billing_account_ref,'creditAccountId',context.credit_account_ref::TEXT,
    'liabilityMerchantAccountId',context.liability_merchant_account_ref,
    'creditHoldRef',p_root_hold_ref::TEXT,'holdState',context.hold_state,
    'holdFenceEpoch',context.fence_epoch::TEXT,'holdReservedAmount',context.reserved_amount::TEXT,
    'holdCapturedAmount',context.captured_amount::TEXT,'holdReleasedAmount',context.released_amount::TEXT,
    'rootAllocationRef',p_root_allocation_ref::TEXT,
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
      'customerAmount',context.customer_amount::TEXT,'ratingSnapshotRef',context.rating_snapshot_ref::TEXT),
    'holdAllocations',sources);
END $$;
REVOKE ALL ON FUNCTION platform.lock_direct_media_root_closure(TEXT,TEXT,UUID,UUID,UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.lock_direct_media_root_closure(TEXT,TEXT,UUID,UUID,UUID,UUID,UUID)
  TO platform_media_worker;

CREATE FUNCTION platform.commit_direct_media_root_closure(p_record JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.credit_direct_media_root_closure_receipt%ROWTYPE; context JSONB; receipt JSONB;
  release JSONB; source RECORD; entry_ordinal INTEGER := 0; release_total NUMERIC(38,0) := 0;
  captured NUMERIC(38,0); released NUMERIC(38,0); release_ref UUID;
  source_allocated_total NUMERIC(38,0); source_captured_total NUMERIC(38,0);
  release_count BIGINT; release_grant_count BIGINT; release_ordinal_count BIGINT;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  SELECT * INTO prior FROM platform.credit_direct_media_root_closure_receipt
   WHERE site_ref=p_record#>>'{identity,siteId}'
     AND (business_operation_key=p_record#>>'{identity,businessOperationKey}'
       OR media_operation_ref=p_record#>>'{identity,operationRef}') FOR UPDATE;
  IF FOUND THEN
    IF prior.business_operation_key<>p_record#>>'{identity,businessOperationKey}'
      OR prior.media_operation_ref<>p_record#>>'{identity,operationRef}'
      OR prior.request_digest<>p_record#>>'{identity,requestDigest}' THEN
      RETURN jsonb_build_object('kind','conflict');
    END IF;
    RETURN jsonb_build_object('kind','replayed','value',platform.direct_media_root_closure_receipt_json(prior));
  END IF;
  receipt := p_record->'receipt';
  context := platform.lock_direct_media_root_closure(
    p_record#>>'{current,siteId}',p_record#>>'{current,operationRef}',
    (p_record#>>'{current,executionBudgetRootRef}')::UUID,
    (p_record#>>'{current,rootAllocationRef}')::UUID,(p_record#>>'{current,creditHoldRef}')::UUID,
    (p_record#>>'{current,settlement,authorizationSegmentRef}')::UUID,
    (p_record#>>'{current,settlement,settlementRef}')::UUID);
  IF context IS NULL THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_CONTEXT_NOT_FOUND'; END IF;
  captured := (p_record->>'capturedAmount')::NUMERIC;
  released := (p_record->>'releasedAmount')::NUMERIC;
  IF context->>'rootState'<>'open' OR context->>'holdState'<>'open'
    OR context#>>'{allocation,state}'<>'active'
    OR (context->>'rootVersion')::BIGINT<>(p_record->>'rootVersion')::BIGINT-1
    OR (context->>'holdFenceEpoch')::BIGINT<>(p_record->>'holdFenceEpoch')::BIGINT-1
    OR (context#>>'{allocation,revision}')::BIGINT<>(p_record#>>'{current,allocation,revision}')::BIGINT
    OR (context#>>'{allocation,allocationEpoch}')::BIGINT<>(p_record#>>'{current,allocation,allocationEpoch}')::BIGINT
    OR (context->>'openChildCount')::BIGINT<>0 OR (context->>'openSegmentCount')::BIGINT<>0
    OR (context->>'openAttemptCount')::BIGINT<>0
    OR captured<>(context->>'holdCapturedAmount')::NUMERIC
    OR captured<>(context#>>'{allocation,capturedCumulative}')::NUMERIC
    OR captured<>(context#>>'{settlement,customerAmount}')::NUMERIC
    OR released<>(context#>>'{allocation,unassignedStock}')::NUMERIC
    OR captured+released<>(context->>'holdReservedAmount')::NUMERIC
    OR p_record#>>'{identity,siteId}'<>context->>'siteId'
    OR p_record#>>'{identity,operationRef}'<>context->>'operationRef'
    OR receipt->>'businessOperationKey'<>p_record#>>'{identity,businessOperationKey}'
    OR receipt->>'requestDigest'<>p_record#>>'{identity,requestDigest}'
    OR receipt->>'siteId'<>context->>'siteId' OR receipt->>'operationRef'<>context->>'operationRef'
    OR receipt->>'executionBudgetRootRef'<>context->>'executionBudgetRootRef'
    OR receipt->>'rootAllocationRef'<>context->>'rootAllocationRef'
    OR receipt->>'rootHoldRef'<>context->>'creditHoldRef'
    OR receipt->>'settlementRef'<>context#>>'{settlement,settlementRef}'
    OR receipt->>'capturedAmount'<>captured::TEXT OR receipt->>'releasedAmount'<>released::TEXT
    OR receipt->>'unit'<>context#>>'{settlement,unit}' THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_COMMIT_FENCE_INVALID';
  END IF;
  SELECT count(*),count(DISTINCT value->>'creditGrantId'),count(DISTINCT value->>'ordinal')
    INTO release_count,release_grant_count,release_ordinal_count
    FROM jsonb_array_elements(p_record->'releases');
  IF release_count<>release_grant_count OR release_count<>release_ordinal_count THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_SOURCE_DUPLICATE';
  END IF;
  SELECT COALESCE(sum(allocation.allocated_amount),0),
         COALESCE(sum(source_net.net_customer_amount),0)
    INTO source_allocated_total,source_captured_total
    FROM platform.credit_hold_allocation allocation
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
        THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS net_customer_amount
        FROM platform.credit_usage_settlement_source settlement_source
       WHERE settlement_source.credit_hold_ref=allocation.credit_hold_ref
         AND settlement_source.credit_grant_id=allocation.credit_grant_id
    ) source_net
   WHERE allocation.credit_hold_ref=(context->>'creditHoldRef')::UUID
     AND allocation.site_ref=context->>'siteId';
  IF source_allocated_total<>(context->>'holdReservedAmount')::NUMERIC
    OR source_captured_total<>captured THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_HOLD_SOURCE_TOTAL_INVALID';
  END IF;
  FOR release IN SELECT value FROM jsonb_array_elements(p_record->'releases') LOOP
    SELECT allocation.credit_grant_id,allocation.allocation_ordinal,allocation.allocated_amount,
           COALESCE(sum(CASE WHEN settlement_source.direction IN ('capture','increase')
             THEN settlement_source.amount ELSE -settlement_source.amount END),0) AS net_customer_amount
      INTO STRICT source
      FROM platform.credit_hold_allocation allocation
      LEFT JOIN platform.credit_usage_settlement_source settlement_source
        ON settlement_source.credit_hold_ref=allocation.credit_hold_ref
       AND settlement_source.credit_grant_id=allocation.credit_grant_id
     WHERE allocation.credit_hold_ref=(context->>'creditHoldRef')::UUID
       AND allocation.site_ref=context->>'siteId'
       AND allocation.credit_grant_id=(release->>'creditGrantId')::UUID
       AND allocation.allocation_ordinal=(release->>'ordinal')::INTEGER
     GROUP BY allocation.credit_grant_id,allocation.allocation_ordinal,allocation.allocated_amount;
    IF (release->>'amount')::NUMERIC<=0
      OR (release->>'amount')::NUMERIC>source.allocated_amount-source.net_customer_amount THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_SOURCE_INVALID';
    END IF;
    release_total := release_total+(release->>'amount')::NUMERIC;
  END LOOP;
  IF release_total<>released
    OR (released=0 AND jsonb_array_length(p_record->'releases')<>0)
    OR (released=0)<>(p_record->>'releaseJournalTransactionRef' IS NULL)
    OR (released=0)<>(p_record->>'releaseEntriesDigest' IS NULL) THEN
    RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RELEASE_TOTAL_INVALID';
  END IF;

  INSERT INTO platform.credit_budget_allocation_revision(
    allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
    credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
    unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
    returned_to_parent_cumulative,state,terminal_receipt_digest)
  VALUES ((p_record->>'allocationRevisionRef')::UUID,(context->>'rootAllocationRef')::UUID,
    (context->>'executionBudgetRootRef')::UUID,context->>'siteId',context->>'billingAccountId',
    (context->>'creditAccountId')::UUID,context#>>'{settlement,unit}',context->>'liabilityMerchantAccountId',
    (p_record#>>'{allocation,revision}')::BIGINT,(p_record#>>'{allocation,allocationEpoch}')::BIGINT,
    (p_record#>>'{allocation,creditCeiling}')::NUMERIC,0,0,0,captured,
    (p_record#>>'{allocation,returnedToParentCumulative}')::NUMERIC,'terminal',receipt->>'receiptDigest');
  UPDATE platform.credit_budget_allocation SET
    current_revision=(p_record#>>'{allocation,revision}')::BIGINT,
    current_allocation_epoch=(p_record#>>'{allocation,allocationEpoch}')::BIGINT
   WHERE budget_allocation_ref=(context->>'rootAllocationRef')::UUID AND site_ref=context->>'siteId'
     AND current_revision=(context#>>'{allocation,revision}')::BIGINT
     AND current_allocation_epoch=(context#>>'{allocation,allocationEpoch}')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_ALLOCATION_CAS_LOST'; END IF;

  IF released>0 THEN
    release_ref := (p_record->>'releaseJournalTransactionRef')::UUID;
    INSERT INTO platform.credit_journal_transaction(
      journal_transaction_ref,credit_account_ref,site_ref,unit,business_operation_key,request_digest,
      operation_kind,expected_entry_count,entries_digest,occurred_at)
    VALUES (release_ref,(context->>'creditAccountId')::UUID,context->>'siteId',context#>>'{settlement,unit}',
      p_record#>>'{identity,businessOperationKey}',p_record#>>'{identity,requestDigest}','hold_release',
      jsonb_array_length(p_record->'releases')*2,p_record->>'releaseEntriesDigest',
      (receipt->>'recordedAt')::TIMESTAMPTZ);
    FOR release IN SELECT value FROM jsonb_array_elements(p_record->'releases') LOOP
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
    fence_epoch=(p_record->>'holdFenceEpoch')::BIGINT,
    settled_at=CASE WHEN captured>0 THEN (receipt->>'recordedAt')::TIMESTAMPTZ ELSE NULL END,
    released_at=CASE WHEN captured=0 THEN (receipt->>'recordedAt')::TIMESTAMPTZ ELSE NULL END,
    updated_at=(receipt->>'recordedAt')::TIMESTAMPTZ
   WHERE credit_hold_ref=(context->>'creditHoldRef')::UUID AND site_ref=context->>'siteId'
     AND state='open' AND fence_epoch=(context->>'holdFenceEpoch')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_HOLD_CAS_LOST'; END IF;
  UPDATE platform.credit_execution_budget_root SET state='settled',
    aggregate_version=(p_record->>'rootVersion')::BIGINT,updated_at=(receipt->>'recordedAt')::TIMESTAMPTZ
   WHERE execution_budget_root_ref=(context->>'executionBudgetRootRef')::UUID AND site_ref=context->>'siteId'
     AND state='open' AND aggregate_version=(context->>'rootVersion')::BIGINT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_ROOT_CAS_LOST'; END IF;
  INSERT INTO platform.credit_direct_media_root_closure_receipt(
    allocation_closure_receipt_ref,site_ref,media_operation_ref,business_operation_key,request_digest,
    effect_closure_receipt_ref,settlement_ref,rating_snapshot_ref,execution_budget_root_ref,
    root_allocation_ref,root_hold_ref,allocation_before_revision,allocation_after_revision,
    allocation_before_epoch,allocation_after_epoch,root_before_version,root_after_version,
    hold_before_fence,hold_after_fence,captured_amount,released_amount,reserved_ceiling,unit,
    release_journal_transaction_ref,receipt_digest,recorded_at)
  VALUES ((receipt->>'allocationClosureReceiptRef')::UUID,receipt->>'siteId',receipt->>'operationRef',
    receipt->>'businessOperationKey',receipt->>'requestDigest',receipt->>'effectClosureReceiptRef',
    (receipt->>'settlementRef')::UUID,(context#>>'{settlement,ratingSnapshotRef}')::UUID,
    (receipt->>'executionBudgetRootRef')::UUID,(receipt->>'rootAllocationRef')::UUID,
    (receipt->>'rootHoldRef')::UUID,(context#>>'{allocation,revision}')::BIGINT,
    (p_record#>>'{allocation,revision}')::BIGINT,(context#>>'{allocation,allocationEpoch}')::BIGINT,
    (p_record#>>'{allocation,allocationEpoch}')::BIGINT,(context->>'rootVersion')::BIGINT,
    (p_record->>'rootVersion')::BIGINT,(context->>'holdFenceEpoch')::BIGINT,
    (p_record->>'holdFenceEpoch')::BIGINT,captured,released,(context->>'holdReservedAmount')::NUMERIC,
    receipt->>'unit',release_ref,receipt->>'receiptDigest',(receipt->>'recordedAt')::TIMESTAMPTZ)
  RETURNING * INTO prior;
  RETURN jsonb_build_object('kind','accepted','value',platform.direct_media_root_closure_receipt_json(prior));
END $$;
REVOKE ALL ON FUNCTION platform.commit_direct_media_root_closure(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.commit_direct_media_root_closure(JSONB) TO platform_media_worker;

CREATE FUNCTION platform.mark_direct_media_root_reconciliation(p_record JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior platform.credit_direct_media_root_reconciliation%ROWTYPE; context JSONB;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  SELECT * INTO prior FROM platform.credit_direct_media_root_reconciliation
   WHERE site_ref=p_record#>>'{current,siteId}'
     AND (business_operation_key=p_record->>'businessOperationKey'
       OR media_operation_ref=p_record#>>'{current,operationRef}') FOR UPDATE;
  IF FOUND THEN
    IF prior.business_operation_key<>p_record->>'businessOperationKey'
      OR prior.media_operation_ref<>p_record#>>'{current,operationRef}'
      OR prior.request_digest<>p_record->>'requestDigest' OR prior.code<>p_record->>'code' THEN
      RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_CONFLICT';
    END IF;
    RETURN jsonb_build_object('kind','replayed');
  END IF;
  context := platform.lock_direct_media_root_closure(
    p_record#>>'{current,siteId}',p_record#>>'{current,operationRef}',
    (p_record#>>'{current,executionBudgetRootRef}')::UUID,
    (p_record#>>'{current,rootAllocationRef}')::UUID,(p_record#>>'{current,creditHoldRef}')::UUID,
    (p_record#>>'{current,settlement,authorizationSegmentRef}')::UUID,
    (p_record#>>'{current,settlement,settlementRef}')::UUID);
  IF context IS NULL THEN RAISE EXCEPTION 'CREDIT_DIRECT_ROOT_RECONCILIATION_CONTEXT_NOT_FOUND'; END IF;
  INSERT INTO platform.credit_budget_allocation_revision(
    allocation_revision_ref,budget_allocation_ref,execution_budget_root_ref,site_ref,billing_account_ref,
    credit_account_ref,unit,liability_merchant_account_ref,revision,allocation_epoch,credit_ceiling,
    unassigned_stock,active_child_reserved_stock,committed_stock,captured_cumulative,
    returned_to_parent_cumulative,state)
  VALUES ((p_record->>'reconciliationReceiptRef')::UUID,(context->>'rootAllocationRef')::UUID,
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
    aggregate_version=aggregate_version+1,updated_at=(p_record->>'observedAt')::TIMESTAMPTZ
   WHERE execution_budget_root_ref=(context->>'executionBudgetRootRef')::UUID
     AND site_ref=context->>'siteId' AND state<>'reconciliation_required';
  UPDATE platform.credit_hold SET state='reconciliation_required',fence_epoch=fence_epoch+1,
    updated_at=(p_record->>'observedAt')::TIMESTAMPTZ
   WHERE credit_hold_ref=(context->>'creditHoldRef')::UUID AND site_ref=context->>'siteId'
     AND state<>'reconciliation_required';
  INSERT INTO platform.credit_direct_media_root_reconciliation(
    reconciliation_receipt_ref,site_ref,media_operation_ref,execution_budget_root_ref,
    root_allocation_ref,root_hold_ref,business_operation_key,request_digest,code,observed_at)
  VALUES ((p_record->>'reconciliationReceiptRef')::UUID,context->>'siteId',context->>'operationRef',
    (context->>'executionBudgetRootRef')::UUID,(context->>'rootAllocationRef')::UUID,
    (context->>'creditHoldRef')::UUID,p_record->>'businessOperationKey',p_record->>'requestDigest',
    p_record->>'code',(p_record->>'observedAt')::TIMESTAMPTZ);
  RETURN jsonb_build_object('kind','accepted');
END $$;
REVOKE ALL ON FUNCTION platform.mark_direct_media_root_reconciliation(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.mark_direct_media_root_reconciliation(JSONB) TO platform_media_worker;

GRANT USAGE ON SCHEMA platform TO platform_media_worker;
REVOKE CREATE ON SCHEMA platform FROM platform_media_worker;
