SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Effect authorization is materialized by Credit/Model owners before this worker may claim work.
-- Capability envelopes contain ciphertext only; bearer handles are never stored as plaintext.
ALTER TABLE platform.media_operation
  ADD COLUMN cancel_intent_receipt_ref TEXT,
  ADD COLUMN cancel_command_ref TEXT UNIQUE,
  ADD COLUMN cancel_request_fingerprint CHAR(64)
    CHECK(cancel_request_fingerprint IS NULL OR cancel_request_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN financial_receipt_ref TEXT,
  ADD COLUMN effect_closure_receipt_ref TEXT,
  ADD COLUMN allocation_closure_receipt_ref TEXT,
  ADD COLUMN usage_settlement_receipt_ref TEXT,
  ADD COLUMN actual_cost NUMERIC(38,0) CHECK(actual_cost IS NULL OR actual_cost>=0),
  ADD COLUMN released_credit NUMERIC(38,0) CHECK(released_credit IS NULL OR released_credit>=0),
  ADD COLUMN terminal_credit_unit TEXT,
  ADD COLUMN gateway_command_receipt_ref TEXT,
  ADD COLUMN gateway_command_receipt_digest CHAR(64)
    CHECK(gateway_command_receipt_digest IS NULL OR gateway_command_receipt_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN canonical_outcome_evidence_ref TEXT,
  ADD COLUMN canonical_outcome_evidence_digest CHAR(64)
    CHECK(canonical_outcome_evidence_digest IS NULL OR canonical_outcome_evidence_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN effect_attempt_ordinal INTEGER CHECK(effect_attempt_ordinal=1),
  ADD COLUMN effect_budget_commit_digest CHAR(64)
    CHECK(effect_budget_commit_digest IS NULL OR effect_budget_commit_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN gateway_caller_request_fingerprint CHAR(64)
    CHECK(gateway_caller_request_fingerprint IS NULL OR gateway_caller_request_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN gateway_create_effect_digest CHAR(64)
    CHECK(gateway_create_effect_digest IS NULL OR gateway_create_effect_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN definition_role_ref TEXT,
  ADD COLUMN operation_input_revision_digest CHAR(64)
    CHECK(operation_input_revision_digest IS NULL OR operation_input_revision_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN trust_effect_allow_receipt_ref TEXT,
  ADD COLUMN trust_effect_allow_receipt_digest CHAR(64)
    CHECK(trust_effect_allow_receipt_digest IS NULL OR trust_effect_allow_receipt_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN source_grants JSONB NOT NULL DEFAULT '[]'::JSONB
    CHECK(jsonb_typeof(source_grants)='array' AND jsonb_array_length(source_grants)<=16),
  ADD COLUMN caller_access_capability_envelope JSONB,
  ADD COLUMN caller_access_handle_digest CHAR(64)
    CHECK(caller_access_handle_digest IS NULL OR caller_access_handle_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN caller_access_expires_at TIMESTAMPTZ,
  ADD COLUMN caller_access_binding_ref TEXT,
  ADD COLUMN model_option_authorization_capability_envelope JSONB,
  ADD COLUMN model_option_authorization_handle_digest CHAR(64)
    CHECK(model_option_authorization_handle_digest IS NULL OR
          model_option_authorization_handle_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN model_option_authorization_expires_at TIMESTAMPTZ,
  ADD COLUMN model_option_authorization_binding_ref TEXT;

ALTER TABLE platform.media_operation
  ADD COLUMN terminal_failure JSONB
    CHECK(terminal_failure IS NULL OR jsonb_typeof(terminal_failure)='object'),
  ADD CONSTRAINT media_operation_terminal_failure_shape CHECK(
    (state='failed')=(terminal_failure IS NOT NULL)
  ),
  ADD CONSTRAINT media_operation_credit_terminal_gate CHECK(
    terminal_receipt_ref IS NULL OR
      (effect_closure_receipt_ref IS NOT NULL AND financial_receipt_ref IS NOT NULL AND
       allocation_closure_receipt_ref IS NOT NULL AND
       actual_cost IS NOT NULL AND released_credit IS NOT NULL AND terminal_credit_unit IS NOT NULL)
  );

ALTER TABLE platform.media_candidate
  ADD COLUMN stable_output_slot_ref TEXT UNIQUE,
  ADD COLUMN gateway_output_evidence_ref TEXT UNIQUE,
  ADD COLUMN gateway_output_evidence_digest CHAR(64)
    CHECK(gateway_output_evidence_digest IS NULL OR gateway_output_evidence_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN output_access_command_ref TEXT UNIQUE,
  ADD COLUMN output_access_request_fingerprint CHAR(64)
    CHECK(output_access_request_fingerprint IS NULL OR output_access_request_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN artifact_finalization_receipt_ref TEXT,
  ADD COLUMN trust_decision_ref TEXT,
  ADD COLUMN restriction_receipt_ref TEXT,
  ADD COLUMN usage_evidence_receipt_ref TEXT;

ALTER TABLE platform.artifact_version
  ADD CONSTRAINT artifact_restricted_has_no_ready_object CHECK(
    state<>'restricted' OR
    (ready_object_ref IS NULL AND finalization_receipt_ref IS NULL AND trust_decision_ref IS NOT NULL AND
     content_sha256 IS NOT NULL AND byte_size IS NOT NULL AND media_type IS NOT NULL)
  );

ALTER TABLE platform.media_dispatch_outbox
  ADD COLUMN last_error_code TEXT,
  ADD COLUMN last_failed_at TIMESTAMPTZ,
  ADD COLUMN dead_lettered_at TIMESTAMPTZ;

ALTER TABLE platform.artifact_version
  ADD COLUMN staged_cleanup_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(staged_cleanup_attempt_count BETWEEN 0 AND 100),
  ADD COLUMN staged_cleanup_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK(staged_cleanup_lease_epoch>=0),
  ADD COLUMN staged_cleanup_lease_token_hash CHAR(64),
  ADD COLUMN staged_cleanup_worker_id TEXT,
  ADD COLUMN staged_cleanup_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN staged_cleanup_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN staged_cleanup_last_error_code TEXT,
  ADD CONSTRAINT artifact_staged_cleanup_lease_shape CHECK(
    (staged_cleanup_lease_token_hash IS NULL AND staged_cleanup_worker_id IS NULL AND
     staged_cleanup_lease_expires_at IS NULL) OR
    (staged_cleanup_state='pending' AND staged_cleanup_lease_token_hash IS NOT NULL AND
     staged_cleanup_worker_id IS NOT NULL AND staged_cleanup_lease_expires_at IS NOT NULL)
  );

CREATE TABLE platform.media_gateway_effect_journal (
  model_invocation_command_ref TEXT PRIMARY KEY,
  operation_ref TEXT NOT NULL REFERENCES platform.media_operation(operation_ref),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  effect_owner_kind TEXT NOT NULL CHECK(effect_owner_kind='model-gateway.image-effect.v1'),
  state TEXT NOT NULL CHECK(state IN ('started','recorded','outcome_unknown')),
  gateway_command_receipt_ref TEXT UNIQUE,
  gateway_command_receipt_digest CHAR(64)
    CHECK(gateway_command_receipt_digest IS NULL OR gateway_command_receipt_digest ~ '^[a-f0-9]{64}$'),
  owner_result JSONB,
  next_evidence_sequence NUMERIC(20,0) NOT NULL DEFAULT 0
    CHECK(next_evidence_sequence BETWEEN 0 AND 18446744073709551615),
  evidence_caught_up BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ,
  CHECK((state='recorded')=(owner_result IS NOT NULL)),
  CHECK((gateway_command_receipt_ref IS NULL)=(gateway_command_receipt_digest IS NULL))
);

CREATE TABLE platform.media_gateway_effect_evidence (
  operation_ref TEXT NOT NULL REFERENCES platform.media_operation(operation_ref),
  logical_invocation_ref TEXT NOT NULL,
  evidence_sequence NUMERIC(20,0) NOT NULL
    CHECK(evidence_sequence BETWEEN 1 AND 18446744073709551615),
  kind TEXT NOT NULL CHECK(kind IN ('outcome','usage','output')),
  evidence_ref TEXT NOT NULL,
  evidence_digest CHAR(64) NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  fact JSONB NOT NULL CHECK(jsonb_typeof(fact)='object'),
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(operation_ref,logical_invocation_ref,evidence_sequence),
  UNIQUE(operation_ref,logical_invocation_ref,evidence_ref)
);

CREATE TABLE platform.media_gateway_cancel_journal (
  cancel_command_ref TEXT PRIMARY KEY,
  operation_ref TEXT NOT NULL REFERENCES platform.media_operation(operation_ref),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state IN ('started','recorded','outcome_unknown')),
  gateway_command_receipt_ref TEXT UNIQUE,
  gateway_command_receipt_digest CHAR(64)
    CHECK(gateway_command_receipt_digest IS NULL OR gateway_command_receipt_digest ~ '^[a-f0-9]{64}$'),
  owner_result JSONB,
  started_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ,
  last_error_code TEXT,
  CHECK((state='recorded')=(owner_result IS NOT NULL)),
  CHECK((gateway_command_receipt_ref IS NULL)=(gateway_command_receipt_digest IS NULL))
);

CREATE TABLE platform.media_worker_saga_receipt (
  operation_ref TEXT NOT NULL REFERENCES platform.media_operation(operation_ref),
  step TEXT NOT NULL CHECK(step IN
    ('artifact_staged','trust_decision','artifact_ready','usage','financial_closure','projection')),
  binding_ref TEXT NOT NULL,
  receipt JSONB NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY(operation_ref,step,binding_ref)
);

CREATE TABLE platform.media_worker_dead_letter (
  outbox_ref TEXT PRIMARY KEY REFERENCES platform.media_dispatch_outbox(outbox_ref),
  operation_ref TEXT NOT NULL REFERENCES platform.media_operation(operation_ref),
  lease_epoch BIGINT NOT NULL CHECK(lease_epoch>0),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 100),
  error_code TEXT NOT NULL,
  evidence_ref TEXT NOT NULL UNIQUE,
  dead_lettered_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE platform.media_artifact_cleanup_dead_letter (
  artifact_version_ref TEXT PRIMARY KEY REFERENCES platform.artifact_version(artifact_version_ref),
  lease_epoch BIGINT NOT NULL CHECK(lease_epoch>0),
  attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 100),
  error_code TEXT NOT NULL,
  evidence_ref TEXT NOT NULL UNIQUE,
  dead_lettered_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE platform.media_gateway_effect_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_gateway_effect_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_gateway_effect_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_gateway_effect_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_gateway_cancel_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_gateway_cancel_journal FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_worker_saga_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_worker_saga_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_worker_dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_worker_dead_letter FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.media_artifact_cleanup_dead_letter ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.media_artifact_cleanup_dead_letter FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE platform.media_gateway_effect_journal,platform.media_gateway_effect_evidence,
  platform.media_gateway_cancel_journal,
  platform.media_worker_saga_receipt,
  platform.media_worker_dead_letter,platform.media_artifact_cleanup_dead_letter FROM PUBLIC;

CREATE POLICY media_gateway_effect_journal_definer ON platform.media_gateway_effect_journal
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_gateway_effect_evidence_definer ON platform.media_gateway_effect_evidence
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_gateway_cancel_journal_definer ON platform.media_gateway_cancel_journal
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_worker_saga_receipt_definer ON platform.media_worker_saga_receipt
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_worker_dead_letter_definer ON platform.media_worker_dead_letter
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_artifact_cleanup_dead_letter_definer ON platform.media_artifact_cleanup_dead_letter
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_operation_worker_definer ON platform.media_operation
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_input_worker_definer ON platform.media_operation_input_revision
  TO platform_migrator USING(SESSION_USER='platform_media_worker');
CREATE POLICY media_candidate_worker_definer ON platform.media_candidate
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY media_direct_command_journal_worker_definer ON platform.media_direct_command_journal
  TO platform_migrator USING(SESSION_USER='platform_media_worker');
CREATE POLICY artifact_worker_definer ON platform.artifact
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');
CREATE POLICY artifact_version_worker_definer ON platform.artifact_version
  TO platform_migrator USING(SESSION_USER='platform_media_worker')
  WITH CHECK(SESSION_USER='platform_media_worker');

CREATE FUNCTION platform.reject_media_worker_receipt_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN RAISE EXCEPTION 'MEDIA_WORKER_EFFECT_RECEIPT_IMMUTABLE' USING ERRCODE='23000'; END;
$$;
CREATE TRIGGER media_gateway_effect_journal_immutable
  BEFORE DELETE ON platform.media_gateway_effect_journal
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_receipt_mutation();
CREATE TRIGGER media_gateway_effect_evidence_immutable
  BEFORE UPDATE OR DELETE ON platform.media_gateway_effect_evidence
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_receipt_mutation();
CREATE TRIGGER media_gateway_cancel_journal_immutable
  BEFORE DELETE ON platform.media_gateway_cancel_journal
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_receipt_mutation();
CREATE TRIGGER media_worker_saga_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.media_worker_saga_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_receipt_mutation();

CREATE FUNCTION platform.reject_media_worker_dead_letter_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN RAISE EXCEPTION 'MEDIA_WORKER_DEAD_LETTER_IMMUTABLE' USING ERRCODE='23000'; END;
$$;
CREATE TRIGGER media_worker_dead_letter_immutable
  BEFORE UPDATE OR DELETE ON platform.media_worker_dead_letter
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_dead_letter_mutation();
CREATE TRIGGER media_artifact_cleanup_dead_letter_immutable
  BEFORE UPDATE OR DELETE ON platform.media_artifact_cleanup_dead_letter
  FOR EACH ROW EXECUTE FUNCTION platform.reject_media_worker_dead_letter_mutation();
REVOKE ALL ON FUNCTION platform.reject_media_worker_receipt_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_media_worker_dead_letter_mutation() FROM PUBLIC;

CREATE FUNCTION platform.assert_media_image_worker_lease(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  PERFORM 1 FROM platform.media_dispatch_outbox item
   WHERE item.outbox_ref=p_task_ref AND item.operation_ref=p_operation_ref
     AND item.state='leased' AND item.lease_epoch=p_lease_epoch
     AND item.lease_token_hash=p_lease_token_hash
     AND item.lease_expires_at>statement_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_WORKER_LEASE_LOST'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION platform.assert_media_image_worker_lease(TEXT,TEXT,BIGINT,CHAR) FROM PUBLIC;

DROP FUNCTION platform.claim_media_image_task(TEXT,CHAR,INTEGER);
CREATE FUNCTION platform.claim_media_image_task_v2(
  p_worker_id TEXT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS TABLE(
  task_ref TEXT,operation_ref TEXT,lease_epoch BIGINT,operation_state TEXT,
  cancel_intent_receipt_ref TEXT,model_invocation_command_ref TEXT,
  credit_execution_budget_root_ref UUID,credit_authorization_segment_ref UUID,
  credit_execution_manifest_ref TEXT,credit_budget_kind TEXT,credit_parent_allocation_ref UUID,
  credit_child_allocation_ref UUID,credit_allocation_receipt_ref UUID,
  credit_root_hold_ref UUID,credit_root_allocation_ref UUID,credit_root_allocation_revision BIGINT,
  credit_root_allocation_epoch BIGINT,credit_authorization_segment_version BIGINT,
  credit_reserved_ceiling NUMERIC,credit_unit TEXT,
  effect_budget_commit_ref TEXT,effect_budget_commit_digest CHAR(64),
  effect_attempt_ordinal INTEGER,gateway_caller_request_fingerprint CHAR(64),
  gateway_create_effect_digest CHAR(64),definition_role_ref TEXT,
  operation_input_revision_digest CHAR(64),trust_effect_allow_receipt_ref TEXT,
  trust_effect_allow_receipt_digest CHAR(64),source_grants JSONB,
  caller_access_capability_envelope JSONB,caller_access_handle_digest CHAR(64),
  caller_access_expires_at TIMESTAMPTZ,caller_access_binding_ref TEXT,
  model_option_authorization_capability_envelope JSONB,model_option_authorization_handle_digest CHAR(64),
  model_option_authorization_expires_at TIMESTAMPTZ,model_option_authorization_binding_ref TEXT,
  site_ref TEXT,subject_ref TEXT,subject_generation BIGINT,project_ref TEXT,workload_ref TEXT,
  source TEXT,definition_revision_ref TEXT,model_option_revision_ref TEXT,
  site_release_ref TEXT,site_security_epoch BIGINT,policy_epoch BIGINT,workload_binding_epoch BIGINT,
  identity_session_ref TEXT,identity_session_epoch BIGINT,restriction_epoch BIGINT,
  membership_epoch BIGINT,authorization_epoch BIGINT,
  operation_input_revision_ref TEXT,key_revision_ref TEXT,ciphertext BYTEA,content_iv BYTEA,
  content_tag BYTEA,wrapped_dek BYTEA,wrap_iv BYTEA,wrap_tag BYTEA,plaintext_bytes INTEGER,
  candidates JSONB,cancel_command_ref TEXT,cancel_request_fingerprint CHAR(64),saga_checkpoint JSONB
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  IF p_lease_seconds<1 OR p_lease_seconds>300 THEN RAISE EXCEPTION 'MEDIA_LEASE_INVALID'; END IF;
  RETURN QUERY
  WITH candidate AS (
    SELECT item.outbox_ref
      FROM platform.media_dispatch_outbox item
      JOIN platform.media_operation operation ON operation.operation_ref=item.operation_ref
     WHERE ((item.state='pending' AND item.next_attempt_at<=statement_timestamp()) OR
            (item.state='leased' AND item.lease_expires_at<=statement_timestamp()))
       AND operation.effect_budget_commit_ref IS NOT NULL
       AND operation.effect_budget_commit_digest IS NOT NULL
       AND operation.effect_attempt_ordinal=1
       AND operation.gateway_caller_request_fingerprint IS NOT NULL
       AND operation.gateway_create_effect_digest=operation.gateway_caller_request_fingerprint
       AND operation.definition_role_ref IS NOT NULL
       AND operation.operation_input_revision_digest IS NOT NULL
       AND operation.trust_effect_allow_receipt_ref IS NOT NULL
       AND operation.trust_effect_allow_receipt_digest IS NOT NULL
       AND operation.caller_access_capability_envelope IS NOT NULL
       AND operation.caller_access_expires_at>statement_timestamp()
       AND operation.model_option_authorization_capability_envelope IS NOT NULL
       AND operation.model_option_authorization_expires_at>statement_timestamp()
       AND (operation.cancel_intent_receipt_ref IS NULL OR
            (operation.cancel_command_ref IS NOT NULL AND operation.cancel_request_fingerprint IS NOT NULL))
       AND NOT EXISTS(SELECT 1 FROM platform.media_candidate missing_access
                       WHERE missing_access.operation_ref=operation.operation_ref
                         AND (missing_access.stable_output_slot_ref IS NULL OR
                              missing_access.output_access_command_ref IS NULL OR
                              missing_access.output_access_request_fingerprint IS NULL))
       AND NOT EXISTS(SELECT 1 FROM platform.media_worker_dead_letter dead
                       WHERE dead.outbox_ref=item.outbox_ref)
     ORDER BY item.next_attempt_at,item.occurred_at,item.outbox_ref
     FOR UPDATE OF item SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE platform.media_dispatch_outbox item
       SET state='leased',attempt_count=item.attempt_count+1,lease_epoch=item.lease_epoch+1,
           lease_token_hash=p_lease_token_hash,worker_id=p_worker_id,
           lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds),
           last_error_code=NULL,last_failed_at=NULL
      FROM candidate WHERE item.outbox_ref=candidate.outbox_ref
      RETURNING item.*
  )
  SELECT changed.outbox_ref,operation.operation_ref,changed.lease_epoch,operation.state,
         operation.cancel_intent_receipt_ref,candidate_rows.model_invocation_command_ref,
         operation.credit_execution_budget_root_ref,operation.credit_authorization_segment_ref,
         operation.credit_execution_manifest_ref,operation.credit_budget_kind,
         operation.credit_parent_allocation_ref,
         operation.credit_child_allocation_ref,operation.credit_allocation_receipt_ref,
         operation.credit_root_hold_ref,operation.credit_root_allocation_ref,
         operation.credit_root_allocation_revision,operation.credit_root_allocation_epoch,
         operation.credit_authorization_segment_version,
         operation.credit_reserved_ceiling,operation.credit_unit,operation.effect_budget_commit_ref,
         operation.effect_budget_commit_digest,operation.effect_attempt_ordinal,
         operation.gateway_caller_request_fingerprint,operation.gateway_create_effect_digest,
         operation.definition_role_ref,operation.operation_input_revision_digest,
         operation.trust_effect_allow_receipt_ref,operation.trust_effect_allow_receipt_digest,
         operation.source_grants,operation.caller_access_capability_envelope,
         operation.caller_access_handle_digest,operation.caller_access_expires_at,
         operation.caller_access_binding_ref,operation.model_option_authorization_capability_envelope,
         operation.model_option_authorization_handle_digest,operation.model_option_authorization_expires_at,
         operation.model_option_authorization_binding_ref,operation.site_ref,operation.subject_ref,
         operation.subject_generation,operation.project_ref,input.workload_ref,input.source,
         operation.definition_revision_ref,operation.model_option_revision_ref,
         direct_journal.site_release_ref,direct_journal.site_security_epoch,direct_journal.policy_epoch,
         direct_journal.workload_binding_epoch,direct_journal.identity_session_ref,
         direct_journal.identity_session_epoch,direct_journal.restriction_epoch,
         direct_journal.membership_epoch,direct_journal.authorization_epoch,
         input.operation_input_revision_ref,input.key_revision_ref,input.ciphertext,input.content_iv,
         input.content_tag,input.wrapped_dek,input.wrap_iv,input.wrap_tag,input.plaintext_bytes,
         candidate_rows.candidates,operation.cancel_command_ref,operation.cancel_request_fingerprint,
         jsonb_build_object(
           'effectState',COALESCE(effect.state,'none'),
           'effectReceipt',effect.owner_result->'receipt',
           'effectView',effect.owner_result->'invocation',
           'cancelState',COALESCE(cancel_effect.state,'none'),
           'cancelResult',cancel_effect.owner_result,
           'definitionPolicy',jsonb_build_object(
             'partialCompletion',operation.partial_completion,
             'minimumReadyCandidates',operation.minimum_ready_candidates
           ),
           'evidence',jsonb_build_object(
             'logicalInvocationRef',effect.owner_result#>>'{invocation,logicalInvocationRef}',
             'nextEvidenceSequence',COALESCE(effect.next_evidence_sequence,0)::TEXT,
             'caughtUp',COALESCE(effect.evidence_caught_up,false),
             'facts',COALESCE(evidence.facts,'[]'::JSONB)
           ),
           'artifacts',candidate_rows.artifact_checkpoints,
           'usageEvidenceReceiptRef',usage.receipt->>'receiptRef',
           'financialClosure',financial_closure.receipt,
           'projectionReceiptRef',projection.receipt->>'receiptRef'
         )
    FROM changed
    JOIN platform.media_operation operation ON operation.operation_ref=changed.operation_ref
    LEFT JOIN platform.media_direct_command_journal direct_journal
      ON direct_journal.operation_ref=operation.operation_ref
     AND direct_journal.site_ref=operation.site_ref
     AND direct_journal.subject_ref=operation.subject_ref
     AND direct_journal.subject_generation=operation.subject_generation
     AND direct_journal.project_ref=operation.project_ref
     AND direct_journal.state='committed'
     AND operation.credit_budget_kind='direct_root'
    JOIN platform.media_operation_input_revision input
      ON input.operation_input_revision_ref=operation.operation_input_revision_ref
    JOIN LATERAL (
      SELECT min(item.model_invocation_command_ref) AS model_invocation_command_ref,
             jsonb_agg(jsonb_build_object('candidateRef',item.candidate_ref,
               'stableOutputSlotRef',item.stable_output_slot_ref,
               'artifactRef',item.artifact_ref,'artifactVersionRef',item.artifact_version_ref,
               'outputAccessCommandRef',item.output_access_command_ref,
               'outputAccessRequestFingerprint',item.output_access_request_fingerprint,
               'ordinal',item.ordinal) ORDER BY item.ordinal) AS candidates,
             jsonb_agg(jsonb_strip_nulls(jsonb_build_object('candidateOrdinal',item.ordinal,
               'stagedReceipt',staged.receipt,'trustDecision',trust.receipt,
               'readyReceipt',ready.receipt-'finalizationReceiptRef',
               'finalizationReceiptRef',ready.receipt->>'finalizationReceiptRef')) ORDER BY item.ordinal)
               AS artifact_checkpoints
        FROM platform.media_candidate item
        LEFT JOIN platform.media_worker_saga_receipt staged
          ON staged.operation_ref=item.operation_ref AND staged.step='artifact_staged'
         AND staged.binding_ref=item.artifact_version_ref
        LEFT JOIN platform.media_worker_saga_receipt trust
          ON trust.operation_ref=item.operation_ref AND trust.step='trust_decision'
         AND trust.binding_ref=item.artifact_version_ref
        LEFT JOIN platform.media_worker_saga_receipt ready
          ON ready.operation_ref=item.operation_ref AND ready.step='artifact_ready'
         AND ready.binding_ref=item.artifact_version_ref
       WHERE item.operation_ref=operation.operation_ref
    ) candidate_rows ON true
    LEFT JOIN platform.media_gateway_effect_journal effect
      ON effect.operation_ref=operation.operation_ref
     AND effect.model_invocation_command_ref=candidate_rows.model_invocation_command_ref
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(fact.fact ORDER BY fact.evidence_sequence) AS facts
        FROM platform.media_gateway_effect_evidence fact
       WHERE fact.operation_ref=operation.operation_ref
         AND fact.logical_invocation_ref=effect.owner_result#>>'{invocation,logicalInvocationRef}'
    ) evidence ON true
    LEFT JOIN platform.media_gateway_cancel_journal cancel_effect
      ON cancel_effect.operation_ref=operation.operation_ref
     AND cancel_effect.cancel_command_ref=operation.cancel_command_ref
    LEFT JOIN platform.media_worker_saga_receipt usage
      ON usage.operation_ref=operation.operation_ref AND usage.step='usage'
     AND usage.binding_ref=operation.operation_ref
    LEFT JOIN platform.media_worker_saga_receipt financial_closure
      ON financial_closure.operation_ref=operation.operation_ref AND financial_closure.step='financial_closure'
     AND financial_closure.binding_ref=operation.operation_ref
    LEFT JOIN platform.media_worker_saga_receipt projection
      ON projection.operation_ref=operation.operation_ref AND projection.step='projection'
     AND projection.binding_ref=operation.operation_ref
   WHERE (operation.credit_budget_kind='agent_child' AND input.source='agent_runtime' AND
          operation.credit_allocation_receipt_ref IS NOT NULL AND direct_journal.operation_ref IS NULL)
      OR (operation.credit_budget_kind='direct_root' AND input.source='direct_studio' AND
          operation.credit_allocation_receipt_ref IS NULL AND direct_journal.operation_ref IS NOT NULL);
END;
$$;

CREATE FUNCTION platform.renew_media_image_task(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE changed INTEGER;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  IF p_lease_seconds<1 OR p_lease_seconds>300 THEN RAISE EXCEPTION 'MEDIA_LEASE_INVALID'; END IF;
  UPDATE platform.media_dispatch_outbox item
     SET lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
   WHERE item.outbox_ref=p_task_ref AND item.operation_ref=p_operation_ref AND item.state='leased'
     AND item.lease_epoch=p_lease_epoch AND item.lease_token_hash=p_lease_token_hash
     AND item.lease_expires_at>statement_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>1 THEN RAISE EXCEPTION 'MEDIA_WORKER_LEASE_LOST'; END IF;
END;
$$;

CREATE FUNCTION platform.prepare_media_image_gateway_effect(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_request_digest CHAR(64),p_effect_owner_kind TEXT,p_started_at TIMESTAMPTZ
) RETURNS TABLE(request_digest CHAR(64),state TEXT,owner_result JSONB,created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE invocation_ref TEXT; inserted_count INTEGER;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF p_effect_owner_kind<>'model-gateway.image-effect.v1' THEN
    RAISE EXCEPTION 'MEDIA_EFFECT_OWNER_INVALID';
  END IF;
  SELECT min(candidate.model_invocation_command_ref) INTO STRICT invocation_ref
    FROM platform.media_candidate candidate WHERE candidate.operation_ref=p_operation_ref;
  INSERT INTO platform.media_gateway_effect_journal(
    model_invocation_command_ref,operation_ref,request_digest,effect_owner_kind,state,started_at
  ) VALUES(invocation_ref,p_operation_ref,p_request_digest,p_effect_owner_kind,'started',p_started_at)
  ON CONFLICT(model_invocation_command_ref) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF EXISTS(SELECT 1 FROM platform.media_gateway_effect_journal journal
             WHERE journal.model_invocation_command_ref=invocation_ref AND
              (journal.operation_ref<>p_operation_ref OR journal.request_digest<>p_request_digest OR
               journal.effect_owner_kind<>p_effect_owner_kind)) THEN
    RAISE EXCEPTION 'MEDIA_EFFECT_JOURNAL_CONFLICT';
  END IF;
  UPDATE platform.media_operation SET state='active',updated_at=p_started_at
   WHERE operation_ref=p_operation_ref AND state IN ('queued','reconciling');
  UPDATE platform.media_candidate SET state='producing'
   WHERE operation_ref=p_operation_ref AND state='allocated';
  RETURN QUERY SELECT journal.request_digest,journal.state,journal.owner_result,(inserted_count=1)
    FROM platform.media_gateway_effect_journal journal
   WHERE journal.model_invocation_command_ref=invocation_ref;
END;
$$;

CREATE FUNCTION platform.record_media_image_gateway_view(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_request_digest CHAR(64),p_owner_result JSONB,p_gateway_command_receipt_ref TEXT,
  p_gateway_command_receipt_digest CHAR(64),p_recorded_at TIMESTAMPTZ
) RETURNS TABLE(late_cancellation_observed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE invocation_ref TEXT; prior_result JSONB; prior_state TEXT;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF jsonb_typeof(p_owner_result)<>'object' OR jsonb_typeof(p_owner_result->'receipt')<>'object' OR
     p_owner_result#>>'{receipt,receiptRef}'<>p_gateway_command_receipt_ref OR
     p_owner_result#>>'{receipt,receiptDigest}'<>p_gateway_command_receipt_digest OR
     p_owner_result#>>'{receipt,requestDigest}'<>p_request_digest::TEXT THEN
    RAISE EXCEPTION 'MEDIA_GATEWAY_RESULT_INVALID';
  END IF;
  SELECT min(candidate.model_invocation_command_ref) INTO STRICT invocation_ref
    FROM platform.media_candidate candidate WHERE candidate.operation_ref=p_operation_ref;
  SELECT journal.owner_result INTO STRICT prior_result FROM platform.media_gateway_effect_journal journal
   WHERE journal.model_invocation_command_ref=invocation_ref AND journal.operation_ref=p_operation_ref
     AND journal.request_digest=p_request_digest FOR UPDATE;
  IF prior_result IS NOT NULL THEN
    IF prior_result#>>'{receipt,receiptRef}'<>p_gateway_command_receipt_ref OR
       prior_result#>>'{receipt,receiptDigest}'<>p_gateway_command_receipt_digest THEN
      RAISE EXCEPTION 'MEDIA_EFFECT_RESULT_CONFLICT';
    END IF;
    prior_state=prior_result#>>'{invocation,state}';
    IF (prior_result->'invocation' IS NOT NULL AND p_owner_result->'invocation' IS NULL) OR
       (prior_result->'invocation' IS NOT NULL AND p_owner_result->'invocation' IS NOT NULL AND
       (prior_result#>>'{invocation,logicalInvocationRef}'<>p_owner_result#>>'{invocation,logicalInvocationRef}' OR
        prior_result#>>'{invocation,modelInvocationCommandRef}'<>p_owner_result#>>'{invocation,modelInvocationCommandRef}' OR
        (p_owner_result#>>'{invocation,ownerVersion}')::NUMERIC<
          (prior_result#>>'{invocation,ownerVersion}')::NUMERIC OR
        (prior_state IN ('succeeded','failed','canceled') AND prior_result->'invocation' IS DISTINCT FROM
          p_owner_result->'invocation'))) THEN
      RAISE EXCEPTION 'MEDIA_EFFECT_VIEW_CONFLICT';
    END IF;
  END IF;
  UPDATE platform.media_gateway_effect_journal journal
     SET state='recorded',owner_result=p_owner_result,
         gateway_command_receipt_ref=p_gateway_command_receipt_ref,
         gateway_command_receipt_digest=p_gateway_command_receipt_digest,recorded_at=p_recorded_at
   WHERE journal.model_invocation_command_ref=invocation_ref AND journal.operation_ref=p_operation_ref
     AND journal.request_digest=p_request_digest
     AND (journal.owner_result IS NOT DISTINCT FROM prior_result);
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_EFFECT_RESULT_CONFLICT'; END IF;
  RETURN QUERY SELECT operation.state='cancel_requested'
    FROM platform.media_operation operation WHERE operation.operation_ref=p_operation_ref;
END;
$$;

CREATE FUNCTION platform.record_media_image_gateway_owner_view(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_request_digest CHAR(64),p_owner_view JSONB,p_recorded_at TIMESTAMPTZ
) RETURNS TABLE(late_cancellation_observed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE prior_result JSONB; prior_version NUMERIC; next_version NUMERIC;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF jsonb_typeof(p_owner_view)<>'object' OR p_owner_view->>'modelInvocationCommandRef' IS NULL OR
     p_owner_view->>'logicalInvocationRef' IS NULL OR p_owner_view->>'ownerVersion' IS NULL THEN
    RAISE EXCEPTION 'MEDIA_GATEWAY_VIEW_INVALID';
  END IF;
  SELECT journal.owner_result INTO STRICT prior_result
    FROM platform.media_gateway_effect_journal journal
   WHERE journal.operation_ref=p_operation_ref AND journal.request_digest=p_request_digest FOR UPDATE;
  IF prior_result IS NULL OR
     COALESCE(prior_result#>>'{invocation,logicalInvocationRef}',
              prior_result#>>'{receipt,logicalInvocationRef}')<>p_owner_view->>'logicalInvocationRef' OR
     COALESCE(prior_result#>>'{invocation,modelInvocationCommandRef}',
              prior_result#>>'{receipt,callerCommandRef}')<>p_owner_view->>'modelInvocationCommandRef' THEN
    RAISE EXCEPTION 'MEDIA_EFFECT_VIEW_CONFLICT';
  END IF;
  prior_version=COALESCE((prior_result#>>'{invocation,ownerVersion}')::NUMERIC,0);
  next_version=(p_owner_view->>'ownerVersion')::NUMERIC;
  IF next_version<prior_version OR
     (prior_result#>>'{invocation,state}' IN ('succeeded','failed','canceled') AND
      prior_result->'invocation' IS DISTINCT FROM p_owner_view) THEN
    RAISE EXCEPTION 'MEDIA_EFFECT_VIEW_VERSION_REGRESSION';
  END IF;
  UPDATE platform.media_gateway_effect_journal
     SET owner_result=jsonb_set(prior_result,'{invocation}',p_owner_view,true),recorded_at=p_recorded_at
   WHERE operation_ref=p_operation_ref AND request_digest=p_request_digest;
  RETURN QUERY SELECT operation.state='cancel_requested'
    FROM platform.media_operation operation WHERE operation.operation_ref=p_operation_ref;
END;
$$;

CREATE FUNCTION platform.record_media_image_gateway_evidence_page(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_logical_invocation_ref TEXT,p_prior_next_evidence_sequence NUMERIC,
  p_next_evidence_sequence NUMERIC,p_caught_up BOOLEAN,p_owner_view JSONB,p_facts JSONB,
  p_recorded_at TIMESTAMPTZ
) RETURNS TABLE(evidence_checkpoint JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE journal_record platform.media_gateway_effect_journal%ROWTYPE; fact JSONB;
        expected NUMERIC; existing JSONB;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  SELECT journal.* INTO STRICT journal_record FROM platform.media_gateway_effect_journal journal
   WHERE journal.operation_ref=p_operation_ref FOR UPDATE;
  IF journal_record.state<>'recorded' OR
     journal_record.owner_result#>>'{invocation,logicalInvocationRef}'<>p_logical_invocation_ref OR
     journal_record.next_evidence_sequence<>p_prior_next_evidence_sequence OR
     jsonb_typeof(p_facts)<>'array' OR jsonb_typeof(p_owner_view)<>'object' OR
     jsonb_array_length(p_facts)>64 OR p_owner_view IS DISTINCT FROM journal_record.owner_result->'invocation' THEN
    RAISE EXCEPTION 'MEDIA_GATEWAY_EVIDENCE_CURSOR_CONFLICT';
  END IF;
  expected=p_prior_next_evidence_sequence+1;
  FOR fact IN SELECT value FROM jsonb_array_elements(p_facts) LOOP
    IF (fact->>'evidenceSequence')::NUMERIC<>expected OR
       fact->>'kind' NOT IN ('outcome','usage','output') OR
       fact->>'evidenceRef' IS NULL OR fact->>'evidenceDigest' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID';
    END IF;
    SELECT stored.fact INTO existing FROM platform.media_gateway_effect_evidence stored
     WHERE stored.operation_ref=p_operation_ref AND stored.logical_invocation_ref=p_logical_invocation_ref
       AND (stored.evidence_sequence=expected OR stored.evidence_ref=fact->>'evidenceRef') FOR UPDATE;
    IF FOUND THEN
      IF existing IS DISTINCT FROM fact THEN RAISE EXCEPTION 'MEDIA_GATEWAY_EVIDENCE_CONFLICT'; END IF;
    ELSE
      INSERT INTO platform.media_gateway_effect_evidence(operation_ref,logical_invocation_ref,
        evidence_sequence,kind,evidence_ref,evidence_digest,fact,recorded_at)
        VALUES(p_operation_ref,p_logical_invocation_ref,expected,fact->>'kind',fact->>'evidenceRef',
          fact->>'evidenceDigest',fact,(fact->>'recordedAt')::TIMESTAMPTZ);
    END IF;
    IF fact->>'kind'='output' THEN
      IF fact->>'candidateRef' IS NULL OR fact->>'stableOutputSlotRef' IS NULL OR
         fact->>'candidateOrdinal' IS NULL OR fact->>'candidateOrdinal' !~ '^[1-9][0-9]*$' OR
         fact->>'outputEvidenceRef' IS NULL OR fact->>'outputEvidenceDigest' IS NULL OR
         fact->>'outputEvidenceRef'<>fact->>'evidenceRef' OR
         fact->>'outputEvidenceDigest'<>fact->>'evidenceDigest' THEN
        RAISE EXCEPTION 'MEDIA_GATEWAY_OUTPUT_EVIDENCE_INVALID';
      END IF;
      UPDATE platform.media_candidate candidate
         SET gateway_output_evidence_ref=fact->>'outputEvidenceRef',
             gateway_output_evidence_digest=fact->>'outputEvidenceDigest',
             state=CASE WHEN candidate.state IN ('allocated','producing')
                        THEN 'output_received' ELSE candidate.state END
       WHERE candidate.operation_ref=p_operation_ref
         AND candidate.candidate_ref=fact->>'candidateRef'
         AND candidate.stable_output_slot_ref=fact->>'stableOutputSlotRef'
         AND candidate.ordinal=(fact->>'candidateOrdinal')::INTEGER
         AND (candidate.gateway_output_evidence_ref IS NULL OR
              (candidate.gateway_output_evidence_ref=fact->>'outputEvidenceRef' AND
               candidate.gateway_output_evidence_digest=fact->>'outputEvidenceDigest'));
      IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_GATEWAY_OUTPUT_EVIDENCE_CONFLICT'; END IF;
    END IF;
    expected=expected+1;
  END LOOP;
  IF p_next_evidence_sequence<>expected-1 OR
     (NOT p_caught_up AND p_next_evidence_sequence=p_prior_next_evidence_sequence) THEN
    RAISE EXCEPTION 'MEDIA_GATEWAY_EVIDENCE_PAGE_INVALID';
  END IF;
  UPDATE platform.media_gateway_effect_journal
     SET next_evidence_sequence=p_next_evidence_sequence,evidence_caught_up=p_caught_up,
         owner_result=jsonb_set(owner_result,'{invocation}',p_owner_view,true),recorded_at=p_recorded_at
   WHERE operation_ref=p_operation_ref;
  RETURN QUERY SELECT jsonb_build_object('logicalInvocationRef',p_logical_invocation_ref,
    'nextEvidenceSequence',p_next_evidence_sequence::TEXT,'caughtUp',p_caught_up,
    'facts',COALESCE((SELECT jsonb_agg(stored.fact ORDER BY stored.evidence_sequence)
      FROM platform.media_gateway_effect_evidence stored WHERE stored.operation_ref=p_operation_ref
        AND stored.logical_invocation_ref=p_logical_invocation_ref),'[]'::JSONB));
END;
$$;

CREATE FUNCTION platform.prepare_media_image_gateway_cancel(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_cancel_command_ref TEXT,p_request_digest CHAR(64),p_started_at TIMESTAMPTZ
) RETURNS TABLE(request_digest CHAR(64),state TEXT,owner_result JSONB,created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE inserted_count INTEGER;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF NOT EXISTS(SELECT 1 FROM platform.media_operation operation
                 WHERE operation.operation_ref=p_operation_ref
                   AND operation.cancel_command_ref=p_cancel_command_ref
                   AND operation.cancel_request_fingerprint=p_request_digest) THEN
    RAISE EXCEPTION 'MEDIA_CANCEL_COMMAND_CONFLICT';
  END IF;
  INSERT INTO platform.media_gateway_cancel_journal(cancel_command_ref,operation_ref,request_digest,state,started_at)
    VALUES(p_cancel_command_ref,p_operation_ref,p_request_digest,'started',p_started_at)
    ON CONFLICT(cancel_command_ref) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  IF EXISTS(SELECT 1 FROM platform.media_gateway_cancel_journal journal
             WHERE journal.cancel_command_ref=p_cancel_command_ref AND
              (journal.operation_ref<>p_operation_ref OR journal.request_digest<>p_request_digest)) THEN
    RAISE EXCEPTION 'MEDIA_CANCEL_JOURNAL_CONFLICT';
  END IF;
  RETURN QUERY SELECT journal.request_digest,journal.state,journal.owner_result,(inserted_count=1)
    FROM platform.media_gateway_cancel_journal journal
   WHERE journal.cancel_command_ref=p_cancel_command_ref;
END;
$$;

CREATE FUNCTION platform.record_media_image_gateway_cancel_result(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_cancel_command_ref TEXT,p_request_digest CHAR(64),p_owner_result JSONB,
  p_gateway_command_receipt_ref TEXT,p_gateway_command_receipt_digest CHAR(64),p_recorded_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF jsonb_typeof(p_owner_result)<>'object' OR jsonb_typeof(p_owner_result->'receipt')<>'object' OR
     p_owner_result#>>'{receipt,callerCommandRef}'<>p_cancel_command_ref OR
     p_owner_result#>>'{receipt,requestDigest}'<>p_request_digest::TEXT OR
     p_owner_result#>>'{receipt,receiptRef}'<>p_gateway_command_receipt_ref OR
     p_owner_result#>>'{receipt,receiptDigest}'<>p_gateway_command_receipt_digest THEN
    RAISE EXCEPTION 'MEDIA_CANCEL_RESULT_INVALID';
  END IF;
  UPDATE platform.media_gateway_cancel_journal journal
     SET state='recorded',owner_result=p_owner_result,
         gateway_command_receipt_ref=p_gateway_command_receipt_ref,
         gateway_command_receipt_digest=p_gateway_command_receipt_digest,recorded_at=p_recorded_at
   WHERE journal.cancel_command_ref=p_cancel_command_ref AND journal.operation_ref=p_operation_ref
     AND journal.request_digest=p_request_digest
     AND (journal.owner_result IS NULL OR journal.owner_result=p_owner_result OR
          (journal.owner_result#>>'{receipt,receiptRef}'=p_gateway_command_receipt_ref AND
           journal.owner_result#>>'{receipt,receiptDigest}'=p_gateway_command_receipt_digest));
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_CANCEL_RESULT_CONFLICT'; END IF;
END;
$$;

CREATE FUNCTION platform.record_media_image_gateway_cancel_outcome_unknown(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_cancel_command_ref TEXT,p_request_digest CHAR(64),p_error_code TEXT,p_observed_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  UPDATE platform.media_gateway_cancel_journal journal SET state='outcome_unknown',recorded_at=p_observed_at,
         last_error_code=p_error_code
   WHERE journal.cancel_command_ref=p_cancel_command_ref AND journal.operation_ref=p_operation_ref
     AND journal.request_digest=p_request_digest AND journal.state IN ('started','outcome_unknown');
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_CANCEL_JOURNAL_MISSING'; END IF;
END;
$$;

CREATE FUNCTION platform.record_media_image_outcome_unknown(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_error_code TEXT,p_observed_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  UPDATE platform.media_gateway_effect_journal journal SET state='outcome_unknown',recorded_at=p_observed_at
   WHERE journal.operation_ref=p_operation_ref AND journal.state IN ('started','outcome_unknown');
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_EFFECT_JOURNAL_MISSING'; END IF;
  UPDATE platform.media_operation SET state='reconciling',updated_at=p_observed_at
   WHERE operation_ref=p_operation_ref AND state NOT IN ('completed','partial','failed','canceled');
END;
$$;

CREATE FUNCTION platform.record_media_image_saga_receipt(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_step TEXT,p_binding_ref TEXT,p_receipt JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE existing JSONB;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  IF p_step NOT IN ('artifact_staged','trust_decision','artifact_ready','usage','financial_closure','projection') OR
     jsonb_typeof(p_receipt)<>'object' THEN RAISE EXCEPTION 'MEDIA_SAGA_RECEIPT_INVALID'; END IF;
  INSERT INTO platform.media_worker_saga_receipt(operation_ref,step,binding_ref,receipt)
    VALUES(p_operation_ref,p_step,p_binding_ref,p_receipt) ON CONFLICT DO NOTHING;
  SELECT receipt INTO STRICT existing FROM platform.media_worker_saga_receipt
   WHERE operation_ref=p_operation_ref AND step=p_step AND binding_ref=p_binding_ref;
  IF existing IS DISTINCT FROM p_receipt THEN RAISE EXCEPTION 'MEDIA_SAGA_RECEIPT_CONFLICT'; END IF;
  IF p_step='artifact_staged' THEN
    IF p_receipt->>'state' IS DISTINCT FROM 'staged' OR p_receipt->>'artifactRef' IS NULL OR
       p_receipt->>'artifactVersionRef' IS NULL OR p_receipt->>'stagedObjectRef' IS NULL OR
       p_receipt->>'contentSha256' IS NULL OR p_receipt->>'contentSha256' !~ '^[a-f0-9]{64}$' OR
       p_receipt->>'byteSize' IS NULL OR p_receipt->>'mediaType' IS NULL OR p_receipt->>'mediaType' NOT IN
         ('image/png','image/jpeg','image/webp') THEN
      RAISE EXCEPTION 'MEDIA_ARTIFACT_STAGED_RECEIPT_INVALID';
    END IF;
    UPDATE platform.artifact_version version
       SET state='staged',staged_object_ref=p_receipt->>'stagedObjectRef',
      content_sha256=p_receipt->>'contentSha256',byte_size=(p_receipt->>'byteSize')::BIGINT,
      media_type=p_receipt->>'mediaType',updated_at=statement_timestamp()
      FROM platform.media_candidate candidate
     WHERE version.artifact_version_ref=p_binding_ref
       AND p_receipt->>'artifactVersionRef'=p_binding_ref
       AND p_receipt->>'artifactRef'=version.artifact_ref
       AND version.state IN ('reserved','retrieving','staged')
       AND candidate.operation_ref=p_operation_ref
       AND candidate.artifact_version_ref=version.artifact_version_ref
       AND candidate.gateway_output_evidence_ref IS NOT NULL
       AND candidate.gateway_output_evidence_digest IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ARTIFACT_STAGED_BINDING_INVALID'; END IF;
    UPDATE platform.media_candidate SET state='validating'
      WHERE operation_ref=p_operation_ref AND artifact_version_ref=p_binding_ref
        AND state IN ('allocated','producing','output_received','validating')
        AND gateway_output_evidence_ref IS NOT NULL AND gateway_output_evidence_digest IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ARTIFACT_STAGED_BINDING_INVALID'; END IF;
  ELSIF p_step='trust_decision' THEN
    IF p_receipt->>'kind' IS NULL OR p_receipt->>'kind' NOT IN ('allow','restrict') OR
       p_receipt->>'decisionRef' IS NULL OR
       p_receipt->>'contentSha256' !~ '^[a-f0-9]{64}$' OR
       (p_receipt->>'kind'='restrict' AND p_receipt->>'reasonCode' IS NULL) THEN
      RAISE EXCEPTION 'MEDIA_TRUST_DECISION_INVALID';
    END IF;
    UPDATE platform.artifact_version version
       SET state=CASE WHEN p_receipt->>'kind'='restrict' THEN 'restricted' ELSE 'validating' END,
           trust_decision_ref=p_receipt->>'decisionRef',
           ready_object_ref=CASE WHEN p_receipt->>'kind'='restrict' THEN NULL ELSE ready_object_ref END,
           finalization_receipt_ref=CASE WHEN p_receipt->>'kind'='restrict'
                                        THEN NULL ELSE finalization_receipt_ref END,
           staged_cleanup_state=CASE WHEN p_receipt->>'kind'='restrict'
                                     THEN 'pending' ELSE staged_cleanup_state END,
           updated_at=statement_timestamp()
      FROM platform.media_candidate candidate
     WHERE version.artifact_version_ref=p_binding_ref
       AND candidate.operation_ref=p_operation_ref
       AND candidate.artifact_version_ref=version.artifact_version_ref
       AND version.state IN ('staged','validating')
       AND version.content_sha256=p_receipt->>'contentSha256'
       AND candidate.gateway_output_evidence_ref IS NOT NULL
       AND candidate.gateway_output_evidence_digest IS NOT NULL;
    IF NOT FOUND THEN
      PERFORM 1 FROM platform.artifact_version version
       WHERE p_receipt->>'kind'='restrict' AND version.artifact_version_ref=p_binding_ref
         AND version.state='restricted' AND version.ready_object_ref IS NULL
         AND version.finalization_receipt_ref IS NULL
         AND version.content_sha256=p_receipt->>'contentSha256'
         AND version.trust_decision_ref=p_receipt->>'decisionRef';
      IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_TRUST_DECISION_BINDING_INVALID'; END IF;
    END IF;
    UPDATE platform.media_candidate candidate
       SET state=CASE WHEN p_receipt->>'kind'='restrict' THEN 'restricted' ELSE 'validating' END,
           trust_decision_ref=p_receipt->>'decisionRef',
           restriction_receipt_ref=CASE WHEN p_receipt->>'kind'='restrict'
                                        THEN p_receipt->>'decisionRef' ELSE NULL END
     WHERE candidate.operation_ref=p_operation_ref AND candidate.artifact_version_ref=p_binding_ref
       AND candidate.state='validating'
       AND candidate.gateway_output_evidence_ref IS NOT NULL
       AND candidate.gateway_output_evidence_digest IS NOT NULL;
    IF NOT FOUND THEN
      PERFORM 1 FROM platform.media_candidate candidate
       WHERE p_receipt->>'kind'='restrict' AND candidate.operation_ref=p_operation_ref
         AND candidate.artifact_version_ref=p_binding_ref AND candidate.state='restricted'
         AND candidate.trust_decision_ref=p_receipt->>'decisionRef'
         AND candidate.restriction_receipt_ref=p_receipt->>'decisionRef'
         AND candidate.gateway_output_evidence_ref IS NOT NULL
         AND candidate.gateway_output_evidence_digest IS NOT NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_TRUST_DECISION_BINDING_INVALID'; END IF;
    END IF;
  ELSIF p_step='artifact_ready' THEN
    IF p_receipt->>'state' IS DISTINCT FROM 'ready_private' OR p_receipt->>'readyObjectRef' IS NULL OR
       p_receipt->>'contentSha256' IS NULL OR p_receipt->>'contentSha256' !~ '^[a-f0-9]{64}$' OR
       p_receipt->>'trustDecisionRef' IS NULL OR p_receipt->>'finalizationReceiptRef' IS NULL OR
       p_receipt#>>'{stagedCleanup,state}' IS NULL OR
       p_receipt#>>'{stagedCleanup,state}' NOT IN ('pending','completed') THEN
      RAISE EXCEPTION 'MEDIA_ARTIFACT_READY_RECEIPT_INVALID';
    END IF;
    UPDATE platform.artifact_version SET state='ready_private',ready_object_ref=p_receipt->>'readyObjectRef',
      trust_decision_ref=p_receipt->>'trustDecisionRef',
      finalization_receipt_ref=p_receipt->>'finalizationReceiptRef',
      staged_cleanup_state=p_receipt#>>'{stagedCleanup,state}',
      staged_object_ref=CASE WHEN p_receipt#>>'{stagedCleanup,state}'='completed' THEN NULL ELSE staged_object_ref END,
      updated_at=statement_timestamp()
      WHERE artifact_version_ref=p_binding_ref AND state='validating'
        AND ready_object_ref IS NULL AND content_sha256=p_receipt->>'contentSha256'
        AND trust_decision_ref=p_receipt->>'trustDecisionRef';
    IF NOT FOUND THEN
      PERFORM 1 FROM platform.artifact_version version
       WHERE version.artifact_version_ref=p_binding_ref AND version.state='ready_private'
         AND version.ready_object_ref=p_receipt->>'readyObjectRef'
         AND version.content_sha256=p_receipt->>'contentSha256'
         AND version.trust_decision_ref=p_receipt->>'trustDecisionRef'
         AND version.finalization_receipt_ref=p_receipt->>'finalizationReceiptRef';
      IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ARTIFACT_READY_BINDING_INVALID'; END IF;
    END IF;
    UPDATE platform.media_candidate SET state='ready',
      artifact_finalization_receipt_ref=p_receipt->>'finalizationReceiptRef'
      WHERE operation_ref=p_operation_ref AND artifact_version_ref=p_binding_ref
        AND state='validating' AND restriction_receipt_ref IS NULL
        AND trust_decision_ref=p_receipt->>'trustDecisionRef';
    IF NOT FOUND THEN
      PERFORM 1 FROM platform.media_candidate candidate
       WHERE candidate.operation_ref=p_operation_ref AND candidate.artifact_version_ref=p_binding_ref
         AND candidate.state='ready' AND candidate.restriction_receipt_ref IS NULL
         AND candidate.trust_decision_ref=p_receipt->>'trustDecisionRef'
         AND candidate.artifact_finalization_receipt_ref=p_receipt->>'finalizationReceiptRef';
      IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_ARTIFACT_READY_BINDING_INVALID'; END IF;
    END IF;
  ELSIF p_step='usage' THEN
    UPDATE platform.media_operation SET usage_evidence_receipt_ref=p_receipt->>'receiptRef'
      WHERE operation_ref=p_operation_ref;
    UPDATE platform.media_candidate SET usage_evidence_receipt_ref=p_receipt->>'receiptRef'
      WHERE operation_ref=p_operation_ref;
  ELSIF p_step='financial_closure' THEN
    IF p_receipt->>'kind'<>'settled' OR p_receipt->>'financialReceiptRef' IS NULL OR
       p_receipt->>'allocationClosureReceiptRef' IS NULL OR
       COALESCE(p_receipt->>'actualCost','') !~ '^(0|[1-9][0-9]{0,37})$' OR
       COALESCE(p_receipt->>'releasedCredit','') !~ '^(0|[1-9][0-9]{0,37})$' OR
       p_receipt->>'unit' IS NULL THEN
      RAISE EXCEPTION 'MEDIA_FINANCIAL_SETTLEMENT_INVALID';
    END IF;
    PERFORM 1 FROM platform.media_operation operation
     WHERE operation.operation_ref=p_operation_ref
       AND operation.credit_unit=p_receipt->>'unit'
       AND operation.credit_reserved_ceiling=
         (p_receipt->>'actualCost')::NUMERIC+(p_receipt->>'releasedCredit')::NUMERIC;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_FINANCIAL_SETTLEMENT_INVALID'; END IF;
    UPDATE platform.media_operation SET
      financial_receipt_ref=p_receipt->>'financialReceiptRef',
      allocation_closure_receipt_ref=p_receipt->>'allocationClosureReceiptRef',
      usage_settlement_receipt_ref=p_receipt->>'usageSettlementReceiptRef',
      actual_cost=(p_receipt->>'actualCost')::NUMERIC,
      released_credit=(p_receipt->>'releasedCredit')::NUMERIC,
      terminal_credit_unit=p_receipt->>'unit'
      WHERE operation_ref=p_operation_ref;
  ELSE
    UPDATE platform.media_operation SET session_projection_receipt_ref=p_receipt->>'receiptRef'
      WHERE operation_ref=p_operation_ref;
  END IF;
END;
$$;

CREATE FUNCTION platform.complete_media_image_task(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),p_closure JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE failure JSONB;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  failure=p_closure->'failureCause';
  IF p_closure->>'state' NOT IN ('completed','partial','failed','canceled') OR
     p_closure->>'terminalReceiptRef' IS NULL OR
     p_closure#>>'{receipts,effectClosureReceiptRef}' IS NULL OR
     p_closure#>>'{receipts,financialReceiptRef}' IS NULL OR
     p_closure#>>'{receipts,allocationClosureReceiptRef}' IS NULL OR
     COALESCE(p_closure#>>'{receipts,actualCost}','') !~ '^(0|[1-9][0-9]{0,37})$' OR
     COALESCE(p_closure#>>'{receipts,releasedCredit}','') !~ '^(0|[1-9][0-9]{0,37})$' OR
     p_closure#>>'{receipts,creditUnit}' IS NULL OR
     ((p_closure->>'state'='failed') IS DISTINCT FROM
       COALESCE(jsonb_typeof(failure)='object',false)) THEN
    RAISE EXCEPTION 'MEDIA_TERMINAL_CLOSURE_INVALID';
  END IF;
  IF p_closure->>'state'='completed' AND EXISTS(
    SELECT 1 FROM platform.media_candidate candidate
     WHERE candidate.operation_ref=p_operation_ref AND candidate.state<>'ready'
  ) THEN
    RAISE EXCEPTION 'MEDIA_TERMINAL_CLOSURE_INVALID';
  END IF;
  IF p_closure->>'state'='partial' AND NOT EXISTS(
    SELECT 1 FROM platform.media_operation operation
     WHERE operation.operation_ref=p_operation_ref AND operation.partial_completion='allowed'
       AND (SELECT count(*) FROM platform.media_candidate ready
             WHERE ready.operation_ref=operation.operation_ref AND ready.state='ready')>=
           operation.minimum_ready_candidates
       AND EXISTS(SELECT 1 FROM platform.media_candidate restricted
                   WHERE restricted.operation_ref=operation.operation_ref
                     AND restricted.state='restricted')
  ) THEN
    RAISE EXCEPTION 'MEDIA_TERMINAL_CLOSURE_INVALID';
  END IF;
  IF p_closure->>'state'='failed' AND failure->>'kind' IN
       ('minimum_ready_candidates_not_met','partial_completion_forbidden') THEN
    PERFORM 1 FROM platform.media_candidate candidate
     WHERE candidate.operation_ref=p_operation_ref
       AND candidate.candidate_ref=failure->>'candidateRef'
       AND candidate.state='restricted'
       AND candidate.gateway_output_evidence_ref=failure->>'outputEvidenceRef'
       AND candidate.gateway_output_evidence_digest=failure->>'outputEvidenceDigest'
       AND candidate.restriction_receipt_ref=failure->>'restrictionReceiptRef';
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_TERMINAL_FAILURE_EVIDENCE_INVALID'; END IF;
    IF failure->>'kind'='minimum_ready_candidates_not_met' AND NOT EXISTS(
      SELECT 1 FROM platform.media_operation operation
       WHERE operation.operation_ref=p_operation_ref AND
         (SELECT count(*) FROM platform.media_candidate ready
           WHERE ready.operation_ref=operation.operation_ref AND ready.state='ready')<
         operation.minimum_ready_candidates
    ) THEN RAISE EXCEPTION 'MEDIA_TERMINAL_FAILURE_CAUSE_INVALID'; END IF;
    IF failure->>'kind'='partial_completion_forbidden' AND NOT EXISTS(
      SELECT 1 FROM platform.media_operation operation
       WHERE operation.operation_ref=p_operation_ref AND operation.partial_completion='forbidden' AND
         (SELECT count(*) FROM platform.media_candidate ready
           WHERE ready.operation_ref=operation.operation_ref AND ready.state='ready')>=
         operation.minimum_ready_candidates
    ) THEN RAISE EXCEPTION 'MEDIA_TERMINAL_FAILURE_CAUSE_INVALID'; END IF;
  ELSIF p_closure->>'state'='failed' AND failure->>'kind'='gateway_effect_failed' THEN
    PERFORM 1 FROM platform.media_gateway_effect_journal journal
      JOIN platform.media_gateway_effect_evidence evidence
        ON evidence.operation_ref=journal.operation_ref
       AND evidence.logical_invocation_ref=failure->>'logicalInvocationRef'
       AND evidence.kind='outcome'
       AND evidence.evidence_ref=failure->>'canonicalOutcomeEvidenceRef'
       AND evidence.evidence_digest=failure->>'canonicalOutcomeEvidenceDigest'
     WHERE journal.operation_ref=p_operation_ref
       AND journal.owner_result#>>'{invocation,state}'='failed';
    IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_TERMINAL_FAILURE_EVIDENCE_INVALID'; END IF;
  ELSIF p_closure->>'state'='failed' THEN
    RAISE EXCEPTION 'MEDIA_TERMINAL_FAILURE_CAUSE_INVALID';
  END IF;
  PERFORM 1 FROM platform.media_operation operation
   WHERE operation.operation_ref=p_operation_ref
     AND operation.financial_receipt_ref=p_closure#>>'{receipts,financialReceiptRef}'
     AND operation.allocation_closure_receipt_ref=p_closure#>>'{receipts,allocationClosureReceiptRef}'
     AND operation.actual_cost=(p_closure#>>'{receipts,actualCost}')::NUMERIC
     AND operation.released_credit=(p_closure#>>'{receipts,releasedCredit}')::NUMERIC
     AND operation.terminal_credit_unit=p_closure#>>'{receipts,creditUnit}'
     AND operation.session_projection_receipt_ref=p_closure#>>'{receipts,projectionReceiptRef}';
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_TERMINAL_FINANCIAL_EVIDENCE_INVALID'; END IF;
  UPDATE platform.media_operation SET state=p_closure->>'state',outcome_class='canonical',
    terminal_receipt_ref=p_closure->>'terminalReceiptRef',
    terminal_failure=failure,
    effect_closure_receipt_ref=p_closure#>>'{receipts,effectClosureReceiptRef}',
    gateway_command_receipt_ref=p_closure#>>'{receipts,gatewayCommandReceiptRef}',
    gateway_command_receipt_digest=p_closure#>>'{receipts,gatewayCommandReceiptDigest}',
    canonical_outcome_evidence_ref=p_closure#>>'{receipts,canonicalOutcomeEvidenceRef}',
    canonical_outcome_evidence_digest=p_closure#>>'{receipts,canonicalOutcomeEvidenceDigest}',
    usage_evidence_receipt_ref=p_closure#>>'{receipts,usageEvidenceReceiptRef}',
    effect_budget_commit_ref=COALESCE(p_closure#>>'{receipts,effectBudgetCommitRef}',effect_budget_commit_ref),
    financial_receipt_ref=p_closure#>>'{receipts,financialReceiptRef}',
    allocation_closure_receipt_ref=p_closure#>>'{receipts,allocationClosureReceiptRef}',
    actual_cost=(p_closure#>>'{receipts,actualCost}')::NUMERIC,
    released_credit=(p_closure#>>'{receipts,releasedCredit}')::NUMERIC,
    terminal_credit_unit=p_closure#>>'{receipts,creditUnit}',
    session_projection_receipt_ref=p_closure#>>'{receipts,projectionReceiptRef}',
    updated_at=(p_closure->>'completedAt')::TIMESTAMPTZ WHERE operation_ref=p_operation_ref;
  UPDATE platform.media_dispatch_outbox SET state='completed',lease_token_hash=NULL,worker_id=NULL,
    lease_expires_at=NULL,completed_at=(p_closure->>'completedAt')::TIMESTAMPTZ
    WHERE outbox_ref=p_task_ref AND operation_ref=p_operation_ref;
END;
$$;

CREATE FUNCTION platform.retry_or_dead_letter_media_image_task(
  p_task_ref TEXT,p_operation_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_error_code TEXT,p_retry_at TIMESTAMPTZ,p_failed_at TIMESTAMPTZ,p_max_attempts INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE attempts INTEGER; evidence TEXT;
BEGIN
  PERFORM platform.assert_media_image_worker_lease(p_task_ref,p_operation_ref,p_lease_epoch,p_lease_token_hash);
  SELECT attempt_count INTO STRICT attempts FROM platform.media_dispatch_outbox WHERE outbox_ref=p_task_ref;
  IF attempts>=p_max_attempts THEN
    evidence='media-worker-dead-letter:'||p_operation_ref||':'||p_lease_epoch::TEXT||':'||p_error_code;
    INSERT INTO platform.media_worker_dead_letter(outbox_ref,operation_ref,lease_epoch,attempt_count,
      error_code,evidence_ref,dead_lettered_at)
      VALUES(p_task_ref,p_operation_ref,p_lease_epoch,attempts,p_error_code,evidence,p_failed_at)
      ON CONFLICT DO NOTHING;
    UPDATE platform.media_dispatch_outbox SET state='dead_letter',lease_token_hash=NULL,worker_id=NULL,
      lease_expires_at=NULL,last_error_code=p_error_code,last_failed_at=p_failed_at,dead_lettered_at=p_failed_at
      WHERE outbox_ref=p_task_ref;
    UPDATE platform.media_operation SET state='reconciling',updated_at=p_failed_at
      WHERE operation_ref=p_operation_ref AND state NOT IN ('completed','partial','failed','canceled');
    RETURN 'dead_letter';
  END IF;
  UPDATE platform.media_dispatch_outbox SET state='pending',lease_token_hash=NULL,worker_id=NULL,
    lease_expires_at=NULL,next_attempt_at=p_retry_at,last_error_code=p_error_code,last_failed_at=p_failed_at
    WHERE outbox_ref=p_task_ref;
  UPDATE platform.media_operation SET state='reconciling',updated_at=p_failed_at
    WHERE operation_ref=p_operation_ref AND state NOT IN ('completed','partial','failed','canceled');
  RETURN 'retry';
END;
$$;

CREATE FUNCTION platform.return_media_image_worker_leases(p_worker_id TEXT,p_reason TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE returned BIGINT;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  UPDATE platform.media_dispatch_outbox SET state='pending',attempt_count=GREATEST(attempt_count-1,0),
    lease_token_hash=NULL,worker_id=NULL,lease_expires_at=NULL,next_attempt_at=statement_timestamp(),
    last_error_code='MEDIA_WORKER_'||upper(replace(p_reason,'-','_'))
   WHERE state='leased' AND worker_id=p_worker_id;
  GET DIAGNOSTICS returned=ROW_COUNT; RETURN returned;
END;
$$;

CREATE FUNCTION platform.claim_media_artifact_cleanup(
  p_worker_id TEXT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS TABLE(artifact_version_ref TEXT,artifact_ref TEXT,staged_object_ref TEXT,lease_epoch BIGINT,
  site_ref TEXT,subject_ref TEXT,subject_generation BIGINT,project_ref TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  RETURN QUERY WITH candidate AS (
    SELECT version.artifact_version_ref FROM platform.artifact_version version
     WHERE version.staged_cleanup_state='pending'
       AND version.staged_cleanup_next_attempt_at<=statement_timestamp()
       AND (version.staged_cleanup_lease_expires_at IS NULL OR
            version.staged_cleanup_lease_expires_at<=statement_timestamp())
     ORDER BY version.staged_cleanup_next_attempt_at,version.artifact_version_ref
     FOR UPDATE SKIP LOCKED LIMIT 1
  ), changed AS (
    UPDATE platform.artifact_version version SET staged_cleanup_attempt_count=version.staged_cleanup_attempt_count+1,
      staged_cleanup_lease_epoch=version.staged_cleanup_lease_epoch+1,
      staged_cleanup_lease_token_hash=p_lease_token_hash,staged_cleanup_worker_id=p_worker_id,
      staged_cleanup_lease_expires_at=statement_timestamp()+make_interval(secs=>p_lease_seconds)
      FROM candidate WHERE version.artifact_version_ref=candidate.artifact_version_ref RETURNING version.*
  ) SELECT changed.artifact_version_ref,changed.artifact_ref,changed.staged_object_ref,
      changed.staged_cleanup_lease_epoch,changed.site_ref,changed.subject_ref,
      changed.subject_generation,changed.project_ref FROM changed;
END;
$$;

CREATE FUNCTION platform.renew_media_artifact_cleanup(
  p_artifact_version_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),p_lease_seconds INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  UPDATE platform.artifact_version SET staged_cleanup_lease_expires_at=
    statement_timestamp()+make_interval(secs=>p_lease_seconds)
   WHERE artifact_version_ref=p_artifact_version_ref AND staged_cleanup_state='pending'
     AND staged_cleanup_lease_epoch=p_lease_epoch AND staged_cleanup_lease_token_hash=p_lease_token_hash
     AND staged_cleanup_lease_expires_at>statement_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_CLEANUP_LEASE_LOST'; END IF;
END;
$$;

CREATE FUNCTION platform.complete_media_artifact_cleanup(
  p_artifact_version_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64)
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  UPDATE platform.artifact_version SET staged_cleanup_state='completed',staged_object_ref=NULL,
    staged_cleanup_lease_token_hash=NULL,staged_cleanup_worker_id=NULL,staged_cleanup_lease_expires_at=NULL
   WHERE artifact_version_ref=p_artifact_version_ref AND staged_cleanup_state='pending'
     AND staged_cleanup_lease_epoch=p_lease_epoch AND staged_cleanup_lease_token_hash=p_lease_token_hash
     AND staged_cleanup_lease_expires_at>statement_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_CLEANUP_LEASE_LOST'; END IF;
END;
$$;

CREATE FUNCTION platform.retry_media_artifact_cleanup(
  p_artifact_version_ref TEXT,p_lease_epoch BIGINT,p_lease_token_hash CHAR(64),
  p_error_code TEXT,p_retry_at TIMESTAMPTZ,p_failed_at TIMESTAMPTZ,p_max_attempts INTEGER
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE attempts INTEGER;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  SELECT staged_cleanup_attempt_count INTO STRICT attempts FROM platform.artifact_version
   WHERE artifact_version_ref=p_artifact_version_ref AND staged_cleanup_state='pending'
     AND staged_cleanup_lease_epoch=p_lease_epoch AND staged_cleanup_lease_token_hash=p_lease_token_hash
     AND staged_cleanup_lease_expires_at>statement_timestamp() FOR UPDATE;
  IF attempts>=p_max_attempts THEN
    INSERT INTO platform.media_artifact_cleanup_dead_letter(artifact_version_ref,lease_epoch,attempt_count,
      error_code,evidence_ref,dead_lettered_at) VALUES(p_artifact_version_ref,p_lease_epoch,attempts,
      p_error_code,'media-cleanup-dead-letter:'||p_artifact_version_ref||':'||p_lease_epoch::TEXT,p_failed_at)
      ON CONFLICT DO NOTHING;
    UPDATE platform.artifact_version SET state='reconciling',staged_cleanup_lease_token_hash=NULL,
      staged_cleanup_worker_id=NULL,staged_cleanup_lease_expires_at=NULL,staged_cleanup_last_error_code=p_error_code
      WHERE artifact_version_ref=p_artifact_version_ref;
    RETURN 'dead_letter';
  END IF;
  UPDATE platform.artifact_version SET staged_cleanup_lease_token_hash=NULL,staged_cleanup_worker_id=NULL,
    staged_cleanup_lease_expires_at=NULL,staged_cleanup_next_attempt_at=p_retry_at,
    staged_cleanup_last_error_code=p_error_code WHERE artifact_version_ref=p_artifact_version_ref;
  RETURN 'retry';
END;
$$;

CREATE FUNCTION platform.return_media_artifact_cleanup_leases(p_worker_id TEXT,p_reason TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE returned BIGINT;
BEGIN
  PERFORM platform.assert_media_runtime_role('worker');
  UPDATE platform.artifact_version SET
    staged_cleanup_attempt_count=GREATEST(staged_cleanup_attempt_count-1,0),
    staged_cleanup_lease_token_hash=NULL,staged_cleanup_worker_id=NULL,
    staged_cleanup_lease_expires_at=NULL,staged_cleanup_next_attempt_at=statement_timestamp(),
    staged_cleanup_last_error_code='MEDIA_CLEANUP_'||upper(replace(p_reason,'-','_'))
   WHERE staged_cleanup_state='pending' AND staged_cleanup_worker_id=p_worker_id;
  GET DIAGNOSTICS returned=ROW_COUNT; RETURN returned;
END;
$$;

DO $$ DECLARE constraint_name TEXT;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid='platform.media_operation'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%usage_evidence_receipt_ref IS NOT NULL%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE platform.media_operation DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
ALTER TABLE platform.media_operation ADD CONSTRAINT media_operation_terminal_owner_receipts CHECK(
  terminal_receipt_ref IS NULL OR
  (effect_closure_receipt_ref IS NOT NULL AND financial_receipt_ref IS NOT NULL AND
   allocation_closure_receipt_ref IS NOT NULL AND
   actual_cost IS NOT NULL AND released_credit IS NOT NULL AND terminal_credit_unit IS NOT NULL AND
   session_projection_receipt_ref IS NOT NULL AND
   (gateway_command_receipt_ref IS NULL)=(gateway_command_receipt_digest IS NULL) AND
   ((state='canceled' AND gateway_command_receipt_ref IS NULL AND canonical_outcome_evidence_ref IS NULL AND
     canonical_outcome_evidence_digest IS NULL) OR
    (gateway_command_receipt_ref IS NOT NULL AND canonical_outcome_evidence_ref IS NOT NULL AND
     canonical_outcome_evidence_digest IS NOT NULL)) AND
   (state='canceled' OR (usage_evidence_receipt_ref IS NOT NULL AND effect_budget_commit_ref IS NOT NULL)))
);

REVOKE ALL ON FUNCTION platform.claim_media_image_task_v2(TEXT,CHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.renew_media_image_task(TEXT,TEXT,BIGINT,CHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.prepare_media_image_gateway_effect(TEXT,TEXT,BIGINT,CHAR,CHAR,TEXT,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_gateway_view(TEXT,TEXT,BIGINT,CHAR,CHAR,JSONB,TEXT,CHAR,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_gateway_owner_view(TEXT,TEXT,BIGINT,CHAR,CHAR,JSONB,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_gateway_evidence_page(TEXT,TEXT,BIGINT,CHAR,TEXT,NUMERIC,NUMERIC,BOOLEAN,JSONB,JSONB,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.prepare_media_image_gateway_cancel(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_gateway_cancel_result(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,JSONB,TEXT,CHAR,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_gateway_cancel_outcome_unknown(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,TEXT,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_outcome_unknown(TEXT,TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_media_image_saga_receipt(TEXT,TEXT,BIGINT,CHAR,TEXT,TEXT,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.complete_media_image_task(TEXT,TEXT,BIGINT,CHAR,JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.retry_or_dead_letter_media_image_task(TEXT,TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.return_media_image_worker_leases(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.claim_media_artifact_cleanup(TEXT,CHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.renew_media_artifact_cleanup(TEXT,BIGINT,CHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.complete_media_artifact_cleanup(TEXT,BIGINT,CHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.retry_media_artifact_cleanup(TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.return_media_artifact_cleanup_leases(TEXT,TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION platform.claim_media_image_task_v2(TEXT,CHAR,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.renew_media_image_task(TEXT,TEXT,BIGINT,CHAR,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.prepare_media_image_gateway_effect(TEXT,TEXT,BIGINT,CHAR,CHAR,TEXT,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_gateway_view(TEXT,TEXT,BIGINT,CHAR,CHAR,JSONB,TEXT,CHAR,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_gateway_owner_view(TEXT,TEXT,BIGINT,CHAR,CHAR,JSONB,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_gateway_evidence_page(TEXT,TEXT,BIGINT,CHAR,TEXT,NUMERIC,NUMERIC,BOOLEAN,JSONB,JSONB,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.prepare_media_image_gateway_cancel(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_gateway_cancel_result(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,JSONB,TEXT,CHAR,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_gateway_cancel_outcome_unknown(TEXT,TEXT,BIGINT,CHAR,TEXT,CHAR,TEXT,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_outcome_unknown(TEXT,TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.record_media_image_saga_receipt(TEXT,TEXT,BIGINT,CHAR,TEXT,TEXT,JSONB) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.complete_media_image_task(TEXT,TEXT,BIGINT,CHAR,JSONB) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.retry_or_dead_letter_media_image_task(TEXT,TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.return_media_image_worker_leases(TEXT,TEXT) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.claim_media_artifact_cleanup(TEXT,CHAR,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.renew_media_artifact_cleanup(TEXT,BIGINT,CHAR,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.complete_media_artifact_cleanup(TEXT,BIGINT,CHAR) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.retry_media_artifact_cleanup(TEXT,BIGINT,CHAR,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,INTEGER) TO platform_media_worker;
GRANT EXECUTE ON FUNCTION platform.return_media_artifact_cleanup_leases(TEXT,TEXT) TO platform_media_worker;
