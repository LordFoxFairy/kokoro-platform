SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Forward-only repair for already-migrated Credit databases. Usage correction facts are
-- immutable; their financial projection therefore advances the allocation and Hold by the
-- signed net customer-consumed movement while preserving the terminal closure definer edge.

CREATE OR REPLACE FUNCTION platform.advance_credit_budget_allocation_revision() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  head_revision BIGINT;
  head_epoch BIGINT;
  target_is_root BOOLEAN;
  root_reserved_ceiling NUMERIC(38,0);
  prior platform.credit_budget_allocation_revision%ROWTYPE;
BEGIN
  SELECT allocation.current_revision,allocation.current_allocation_epoch,allocation.is_root,root.reserved_ceiling
    INTO head_revision,head_epoch,target_is_root,root_reserved_ceiling
  FROM platform.credit_budget_allocation allocation
  JOIN platform.credit_execution_budget_root root
    ON root.execution_budget_root_ref=allocation.execution_budget_root_ref
  WHERE allocation.budget_allocation_ref=NEW.budget_allocation_ref
  FOR UPDATE OF allocation;
  IF head_revision IS NULL OR NEW.revision<>head_revision+1 THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  IF target_is_root AND NEW.credit_ceiling<>root_reserved_ceiling THEN
    RAISE EXCEPTION 'CREDIT_ROOT_ALLOCATION_CEILING_DRIFT' USING ERRCODE='23514';
  END IF;
  IF head_revision=0 THEN
    IF NEW.revision<>1 OR NEW.allocation_epoch<>1 OR NEW.state<>'active'
       OR NEW.captured_cumulative<>0 OR NEW.returned_to_parent_cumulative<>0 THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_INITIAL_REVISION_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO prior
    FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.budget_allocation_ref AND revision=head_revision;
    IF prior.state='terminal'
       OR NEW.allocation_epoch NOT IN (head_epoch,head_epoch+1)
       OR NEW.credit_ceiling<>prior.credit_ceiling
       OR NEW.returned_to_parent_cumulative<prior.returned_to_parent_cumulative THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_TRANSITION_INVALID' USING ERRCODE='23514';
    END IF;
    IF NEW.captured_cumulative<prior.captured_cumulative AND (
         prior.state NOT IN ('active','reconciliation_required')
         OR NEW.allocation_epoch<>head_epoch
         OR NEW.unassigned_stock-prior.unassigned_stock<>
            prior.captured_cumulative-NEW.captured_cumulative
         OR NEW.active_child_reserved_stock<>prior.active_child_reserved_stock
         OR NEW.committed_stock<>prior.committed_stock
         OR NEW.returned_to_parent_cumulative<>prior.returned_to_parent_cumulative
         OR NEW.state<>prior.state
       ) THEN
      RAISE EXCEPTION 'CREDIT_ALLOCATION_CAPTURE_CORRECTION_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  UPDATE platform.credit_budget_allocation
  SET current_revision=NEW.revision,current_allocation_epoch=NEW.allocation_epoch
  WHERE budget_allocation_ref=NEW.budget_allocation_ref
    AND current_revision=head_revision AND current_allocation_epoch=head_epoch;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_ALLOCATION_REVISION_CAS_FAILED' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

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
  IF NEW.released_amount<OLD.released_amount
     OR OLD.state IN ('settled','released','expired')
     OR (OLD.state='open' AND NEW.state NOT IN ('open','closing','settled','released','expired','reconciliation_required'))
     OR (OLD.state='open' AND NEW.state='settled' AND (
       current_setting('app.credit_execution_root_closure_transition',true) IS DISTINCT FROM 'commit'
       OR CURRENT_USER=SESSION_USER OR CURRENT_USER IS DISTINCT FROM relation_owner))
     OR (OLD.state='closing' AND NEW.state NOT IN ('closing','settled','reconciliation_required'))
     OR (OLD.state='reconciliation_required' AND NEW.state NOT IN ('reconciliation_required','closing','settled')) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NEW.captured_amount<OLD.captured_amount AND (
       OLD.state NOT IN ('open','closing','reconciliation_required')
       OR NEW.state<>OLD.state
       OR NEW.released_amount<>OLD.released_amount
       OR NEW.resolution_kind IS DISTINCT FROM OLD.resolution_kind
       OR NEW.resolution_ref IS DISTINCT FROM OLD.resolution_ref
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
       OR NEW.released_at IS DISTINCT FROM OLD.released_at
     ) THEN
    RAISE EXCEPTION 'CREDIT_HOLD_CAPTURE_CORRECTION_INVALID' USING ERRCODE='23514';
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

CREATE OR REPLACE FUNCTION platform.assert_credit_journal_cross_fact_conservation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  payload JSONB := to_jsonb(NEW);
  target_grant_id UUID := NULLIF(payload->>'credit_grant_id','')::UUID;
  target_hold_ref UUID := NULLIF(payload->>'credit_hold_ref','')::UUID;
  grant_fact platform.credit_grant%ROWTYPE;
  program_fact platform.commerce_credit_program_revision%ROWTYPE;
  hold_fact platform.credit_hold%ROWTYPE;
  allocation_fact platform.credit_hold_allocation%ROWTYPE;
  issue_debit NUMERIC(38,0);
  issue_credit NUMERIC(38,0);
  issue_transaction_count INTEGER;
  reserve_debit NUMERIC(38,0);
  reserve_credit NUMERIC(38,0);
  reserve_transaction_count INTEGER;
  captured_total NUMERIC(38,0);
  released_total NUMERIC(38,0);
  hold_captured_total NUMERIC(38,0);
  hold_released_total NUMERIC(38,0);
  linked_operation_kind TEXT;
  available_balance NUMERIC(38,0);
  reserved_balance NUMERIC(38,0);
  consumed_balance NUMERIC(38,0);
  expired_balance NUMERIC(38,0);
  revoked_balance NUMERIC(38,0);
BEGIN
  IF target_grant_id IS NOT NULL THEN
    SELECT * INTO grant_fact FROM platform.credit_grant
    WHERE credit_grant_id=target_grant_id;
    SELECT * INTO program_fact FROM platform.commerce_credit_program_revision
    WHERE credit_program_revision_ref=grant_fact.credit_program_revision_ref;
    SELECT operation_kind INTO linked_operation_kind
    FROM platform.credit_journal_transaction
    WHERE journal_transaction_ref=grant_fact.issuance_journal_transaction_ref;
    SELECT
      COALESCE(sum(entry.amount) FILTER (
        WHERE entry.entry_side='debit' AND entry.account_type='grant_issuance_source'
      ),0),
      COALESCE(sum(entry.amount) FILTER (
        WHERE entry.entry_side='credit' AND entry.account_type='customer_available'
      ),0),
      count(DISTINCT transaction.journal_transaction_ref)::INTEGER
      INTO issue_debit,issue_credit,issue_transaction_count
    FROM platform.credit_journal_entry entry
    JOIN platform.credit_journal_transaction transaction
      ON transaction.journal_transaction_ref=entry.journal_transaction_ref
    WHERE entry.credit_grant_id=target_grant_id AND transaction.operation_kind='grant_issue';
    SELECT
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_available'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_reserved'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='customer_consumed'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='expired'),0),
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
        FILTER (WHERE entry.account_type='revoked'),0)
      INTO available_balance,reserved_balance,consumed_balance,expired_balance,revoked_balance
    FROM platform.credit_journal_entry entry
    WHERE entry.credit_grant_id=target_grant_id;
    IF grant_fact.credit_grant_id IS NULL
       OR program_fact.credit_program_revision_ref IS NULL
       OR grant_fact.ux_bucket_class<>program_fact.ux_bucket_class
       OR grant_fact.unit<>program_fact.unit
       OR grant_fact.liability_merchant_account_ref<>program_fact.liability_merchant_account_ref
       OR grant_fact.original_amount<>program_fact.amount
       OR grant_fact.burn_priority<>program_fact.burn_priority
       OR grant_fact.scope_policy IS DISTINCT FROM program_fact.scope_policy
       OR (program_fact.expires_after_seconds IS NULL)<>(grant_fact.expires_at IS NULL)
       OR (program_fact.expires_after_seconds IS NOT NULL AND grant_fact.expires_at<>
         grant_fact.effective_at+(program_fact.expires_after_seconds*INTERVAL '1 second'))
       OR linked_operation_kind<>'grant_issue'
       OR issue_debit<>grant_fact.original_amount
       OR issue_credit<>grant_fact.original_amount
       OR issue_transaction_count<>1
       OR available_balance<0 OR reserved_balance<0 OR consumed_balance<0
       OR expired_balance<0 OR revoked_balance<0
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         WHERE entry.credit_grant_id=target_grant_id
         GROUP BY entry.journal_transaction_ref
         HAVING COALESCE(sum(entry.amount) FILTER (WHERE entry.entry_side='debit'),0)
              <>COALESCE(sum(entry.amount) FILTER (WHERE entry.entry_side='credit'),0)
       )
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         JOIN platform.credit_journal_transaction transaction
           ON transaction.journal_transaction_ref=entry.journal_transaction_ref
         WHERE entry.credit_grant_id=target_grant_id
           AND transaction.operation_kind='grant_issue'
           AND transaction.journal_transaction_ref<>grant_fact.issuance_journal_transaction_ref
       ) THEN
      RAISE EXCEPTION 'CREDIT_GRANT_ISSUANCE_JOURNAL_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;

  IF target_hold_ref IS NOT NULL THEN
    SELECT * INTO hold_fact FROM platform.credit_hold WHERE credit_hold_ref=target_hold_ref;
    FOR allocation_fact IN
      SELECT * FROM platform.credit_hold_allocation WHERE credit_hold_ref=target_hold_ref
    LOOP
      SELECT operation_kind INTO linked_operation_kind
      FROM platform.credit_journal_transaction
      WHERE journal_transaction_ref=allocation_fact.reserve_journal_transaction_ref;
      SELECT
        COALESCE(sum(entry.amount) FILTER (
          WHERE entry.entry_side='debit' AND entry.account_type='customer_available'
        ),0),
        COALESCE(sum(entry.amount) FILTER (
          WHERE entry.entry_side='credit' AND entry.account_type='customer_reserved'
        ),0),
        count(DISTINCT transaction.journal_transaction_ref)::INTEGER
        INTO reserve_debit,reserve_credit,reserve_transaction_count
      FROM platform.credit_journal_entry entry
      JOIN platform.credit_journal_transaction transaction
        ON transaction.journal_transaction_ref=entry.journal_transaction_ref
      WHERE entry.credit_hold_ref=target_hold_ref
        AND entry.credit_grant_id=allocation_fact.credit_grant_id
        AND transaction.operation_kind='hold_reserve';
      SELECT
        COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
          FILTER (WHERE transaction.operation_kind IN ('hold_capture','correction')
            AND entry.account_type='customer_consumed'),0),
        COALESCE(sum(entry.amount) FILTER (
          WHERE transaction.operation_kind='hold_release'
            AND entry.entry_side='credit' AND entry.account_type IN ('customer_available','expired','revoked')
        ),0)
        INTO captured_total,released_total
      FROM platform.credit_journal_entry entry
      JOIN platform.credit_journal_transaction transaction
        ON transaction.journal_transaction_ref=entry.journal_transaction_ref
      WHERE entry.credit_hold_ref=target_hold_ref
        AND entry.credit_grant_id=allocation_fact.credit_grant_id;
      IF linked_operation_kind<>'hold_reserve'
         OR reserve_debit<>allocation_fact.allocated_amount
         OR reserve_credit<>allocation_fact.allocated_amount
         OR reserve_transaction_count<>1
         OR captured_total+released_total>allocation_fact.allocated_amount
         OR EXISTS (
           SELECT 1
           FROM platform.credit_journal_entry entry
           JOIN platform.credit_journal_transaction transaction
             ON transaction.journal_transaction_ref=entry.journal_transaction_ref
           WHERE entry.credit_hold_ref=target_hold_ref
             AND entry.credit_grant_id=allocation_fact.credit_grant_id
             AND transaction.operation_kind='hold_reserve'
             AND transaction.journal_transaction_ref<>allocation_fact.reserve_journal_transaction_ref
         ) THEN
        RAISE EXCEPTION 'CREDIT_HOLD_ALLOCATION_JOURNAL_MISMATCH' USING ERRCODE='23514';
      END IF;
    END LOOP;
    SELECT
      COALESCE(sum(CASE entry.entry_side WHEN 'credit' THEN entry.amount ELSE -entry.amount END)
          FILTER (WHERE transaction.operation_kind IN ('hold_capture','correction')
            AND entry.account_type='customer_consumed'),0),
      COALESCE(sum(entry.amount) FILTER (
        WHERE transaction.operation_kind='hold_release'
          AND entry.entry_side='credit' AND entry.account_type IN ('customer_available','expired','revoked')
      ),0)
      INTO hold_captured_total,hold_released_total
    FROM platform.credit_journal_entry entry
    JOIN platform.credit_journal_transaction transaction
      ON transaction.journal_transaction_ref=entry.journal_transaction_ref
    WHERE entry.credit_hold_ref=target_hold_ref;
    IF hold_fact.credit_hold_ref IS NULL
       OR hold_fact.captured_amount<>hold_captured_total
       OR hold_fact.released_amount<>hold_released_total
       OR (hold_fact.state IN ('settled','released','expired')
         AND hold_captured_total+hold_released_total<>hold_fact.reserved_amount)
       OR EXISTS (
         SELECT 1
         FROM platform.credit_journal_entry entry
         JOIN platform.credit_journal_transaction transaction
           ON transaction.journal_transaction_ref=entry.journal_transaction_ref
         JOIN platform.credit_grant hold_grant
           ON hold_grant.credit_grant_id=entry.credit_grant_id
         WHERE entry.credit_hold_ref=target_hold_ref
           AND transaction.operation_kind='hold_release'
           AND entry.entry_side='credit'
           AND entry.account_type<>CASE
             WHEN EXISTS (
               SELECT 1
               FROM platform.credit_journal_entry revoke_entry
               JOIN platform.credit_journal_transaction revoke_transaction
                 ON revoke_transaction.journal_transaction_ref=revoke_entry.journal_transaction_ref
               WHERE revoke_entry.credit_grant_id=entry.credit_grant_id
                 AND revoke_transaction.operation_kind='grant_revoke'
                 AND revoke_transaction.occurred_at<=transaction.occurred_at
             ) THEN 'revoked'
             WHEN hold_grant.expires_at IS NOT NULL AND hold_grant.expires_at<=transaction.occurred_at THEN 'expired'
             ELSE 'customer_available'
           END
       ) THEN
      RAISE EXCEPTION 'CREDIT_HOLD_JOURNAL_TOTAL_MISMATCH' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION platform.advance_credit_budget_allocation_revision() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_hold_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_journal_cross_fact_conservation() FROM PUBLIC;
