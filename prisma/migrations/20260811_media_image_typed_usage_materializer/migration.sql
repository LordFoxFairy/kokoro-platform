SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- A committed segment can be closed at zero when cancellation is proven before
-- any Attempt exists. The deferred completeness trigger already proves that the
-- persisted evidence count and contiguous ordinals are exact, including zero.
ALTER TABLE platform.credit_usage_segment_closure
  DROP CONSTRAINT credit_usage_segment_closure_expected_evidence_count_check,
  ADD CONSTRAINT credit_usage_segment_closure_expected_evidence_count_check
    CHECK(expected_evidence_count BETWEEN 0 AND 4096);

-- Same-Platform owner bridge. The Media worker supplies only identities already
-- frozen on its operation; the function resolves the certified typed usage fact
-- from Model Gateway's append-only evidence ledger. It returns the immutable
-- pre-effect authorization fence; Credit's finalizeAttempt owner decides whether
-- that fence is live or an idempotent finalized-command replay.
CREATE FUNCTION platform.load_media_image_effect_usage_fact(
  p_task_ref TEXT,
  p_operation_ref TEXT,
  p_lease_epoch BIGINT,
  p_lease_token_hash CHAR(64),
  p_model_invocation_command_ref TEXT,
  p_logical_invocation_ref TEXT,
  p_usage_evidence_ref TEXT,
  p_usage_evidence_digest CHAR(64)
) RETURNS TABLE(
  attempt_ref TEXT,
  attempt_authorization_ref UUID,
  attempt_authorization_fence_epoch BIGINT,
  attempt_authorization_digest CHAR(64),
  authorization_segment_ref UUID,
  execution_manifest_ref TEXT,
  producer_kind TEXT,
  producer_context TEXT,
  producer_generation BIGINT,
  logical_effect_ref TEXT,
  usage_evidence_ref TEXT,
  usage_evidence_digest CHAR(64),
  usage_fact JSONB,
  recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  RETURN QUERY
  SELECT ledger.attempt_ref,attempt.attempt_authorization_ref,
         attempt.attempt_authorization_fence_epoch,
         attempt.attempt_authorization_digest,
         intent.authorization_segment_ref,intent.execution_manifest_ref,
         intent.producer_kind,intent.producer_context,intent.producer_generation,
         intent.logical_effect_ref,
         ledger.evidence_ref,ledger.evidence_digest::CHAR(64),
         ledger.usage_fact,ledger.recorded_at
    FROM platform.media_operation operation
    JOIN platform.model_image_effect_invocation invocation
      ON invocation.model_invocation_command_ref=p_model_invocation_command_ref
     AND invocation.logical_invocation_ref=p_logical_invocation_ref
     AND invocation.site_ref=operation.site_ref
    JOIN platform.model_image_effect_evidence_ledger ledger
      ON ledger.logical_invocation_ref=invocation.logical_invocation_ref
     AND ledger.evidence_kind='usage'
     AND ledger.evidence_ref=p_usage_evidence_ref
     AND ledger.evidence_digest=p_usage_evidence_digest
    JOIN platform.model_image_effect_attempt attempt
      ON attempt.logical_invocation_ref=invocation.logical_invocation_ref
     AND attempt.attempt_ref=ledger.attempt_ref
     AND attempt.site_ref=operation.site_ref
    JOIN platform.credit_usage_attempt_intent intent
      ON intent.attempt_authorization_ref=attempt.attempt_authorization_ref
     AND intent.site_ref=operation.site_ref
     AND intent.execution_budget_root_ref=operation.credit_execution_budget_root_ref
     AND intent.budget_allocation_ref=CASE operation.credit_budget_kind
       WHEN 'agent_child' THEN operation.credit_child_allocation_ref
       WHEN 'direct_root' THEN operation.credit_root_allocation_ref
     END
     AND intent.authorization_segment_ref=operation.credit_authorization_segment_ref
     AND intent.execution_manifest_ref=operation.credit_execution_manifest_ref
     AND intent.attempt_ref=ledger.attempt_ref
     AND intent.logical_effect_ref=invocation.logical_invocation_ref
     AND intent.producer_kind='model_gateway'
   WHERE operation.operation_ref=p_operation_ref
     AND EXISTS(
       SELECT 1 FROM platform.media_candidate candidate
        WHERE candidate.operation_ref=operation.operation_ref
          AND candidate.model_invocation_command_ref=p_model_invocation_command_ref
     );
END;
$$;

REVOKE ALL ON FUNCTION platform.load_media_image_effect_usage_fact(TEXT,TEXT,BIGINT,CHAR,TEXT,TEXT,TEXT,CHAR)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.load_media_image_effect_usage_fact(TEXT,TEXT,BIGINT,CHAR,TEXT,TEXT,TEXT,CHAR)
  TO platform_media_worker;
