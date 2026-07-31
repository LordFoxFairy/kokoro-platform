SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Same-Platform owner bridge. The Media worker supplies only identities already
-- frozen on its operation; the function resolves the certified typed usage fact
-- from Model Gateway's append-only evidence ledger.
CREATE FUNCTION platform.load_media_image_effect_usage_fact(
  p_operation_ref TEXT,
  p_model_invocation_command_ref TEXT,
  p_logical_invocation_ref TEXT,
  p_usage_evidence_ref TEXT,
  p_usage_evidence_digest CHAR(64)
) RETURNS TABLE(
  attempt_ref TEXT,
  usage_evidence_ref TEXT,
  usage_evidence_digest CHAR(64),
  usage_fact JSONB,
  recorded_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  RETURN QUERY
  SELECT ledger.attempt_ref,ledger.evidence_ref,ledger.evidence_digest::CHAR(64),
         ledger.usage_fact,ledger.recorded_at
    FROM platform.media_operation operation
    JOIN platform.model_image_effect_invocation invocation
      ON invocation.model_invocation_command_ref=p_model_invocation_command_ref
     AND invocation.logical_invocation_ref=p_logical_invocation_ref
     AND invocation.site_ref=operation.site_ref
    JOIN platform.model_image_effect_evidence_ledger ledger
      ON ledger.logical_invocation_ref=invocation.logical_invocation_ref
     AND ledger.attempt_ref IN (
       SELECT attempt.attempt_ref FROM platform.model_image_effect_attempt attempt
        WHERE attempt.logical_invocation_ref=invocation.logical_invocation_ref
     )
     AND ledger.evidence_kind='usage'
     AND ledger.evidence_ref=p_usage_evidence_ref
     AND ledger.evidence_digest=p_usage_evidence_digest
   WHERE operation.operation_ref=p_operation_ref
     AND EXISTS(
       SELECT 1 FROM platform.media_candidate candidate
        WHERE candidate.operation_ref=operation.operation_ref
          AND candidate.model_invocation_command_ref=p_model_invocation_command_ref
     );
END;
$$;

REVOKE ALL ON FUNCTION platform.load_media_image_effect_usage_fact(TEXT,TEXT,TEXT,TEXT,CHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.load_media_image_effect_usage_fact(TEXT,TEXT,TEXT,TEXT,CHAR)
  TO platform_media_worker;
