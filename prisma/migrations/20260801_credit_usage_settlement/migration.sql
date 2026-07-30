CREATE TABLE platform.credit_rating_policy_revision (
  rating_policy_revision_ref TEXT NOT NULL CHECK(length(rating_policy_revision_ref) BETWEEN 1 AND 256),
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
  policy_digest CHAR(64) NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL CHECK(state='published'),
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(rating_policy_revision_ref,site_ref),
  UNIQUE(rating_policy_revision_ref,site_ref,unit),
  UNIQUE(site_ref,policy_digest)
);

ALTER TABLE platform.credit_execution_budget_root
  ADD CONSTRAINT credit_budget_root_rating_policy_fk
  FOREIGN KEY(rating_policy_revision_ref,site_ref,unit)
  REFERENCES platform.credit_rating_policy_revision(rating_policy_revision_ref,site_ref,unit);
ALTER TABLE platform.credit_authorization_segment
  ADD CONSTRAINT credit_segment_rating_policy_fk
  FOREIGN KEY(rating_policy_revision_ref,site_ref,unit)
  REFERENCES platform.credit_rating_policy_revision(rating_policy_revision_ref,site_ref,unit);

CREATE TABLE platform.credit_rating_snapshot (
  rating_snapshot_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  rating_policy_revision_ref TEXT NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  snapshot_digest CHAR(64) NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(site_ref,authorization_segment_ref),
  UNIQUE(rating_snapshot_ref,site_ref),
  UNIQUE(rating_snapshot_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(rating_policy_revision_ref,site_ref,unit)
    REFERENCES platform.credit_rating_policy_revision(rating_policy_revision_ref,site_ref,unit)
);

CREATE TABLE platform.credit_usage_attempt_intent (
  attempt_authorization_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  budget_allocation_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  execution_manifest_ref TEXT NOT NULL CHECK(length(execution_manifest_ref) BETWEEN 1 AND 256),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('model_gateway','capability_runtime','job_runtime')),
  producer_context TEXT NOT NULL CHECK(length(producer_context) BETWEEN 1 AND 256),
  producer_generation BIGINT NOT NULL CHECK(producer_generation>0),
  attempt_ref TEXT NOT NULL CHECK(length(attempt_ref) BETWEEN 1 AND 256),
  logical_effect_ref TEXT NOT NULL CHECK(length(logical_effect_ref) BETWEEN 1 AND 256),
  maximum_dimensions JSONB NOT NULL CHECK(jsonb_typeof(maximum_dimensions)='array'
    AND jsonb_array_length(maximum_dimensions) BETWEEN 1 AND 64),
  maximum_dimensions_digest CHAR(64) NOT NULL CHECK(maximum_dimensions_digest ~ '^[a-f0-9]{64}$'),
  maximum_amount NUMERIC(38,0) NOT NULL CHECK(maximum_amount>=0),
  provisional_customer_amount NUMERIC(38,0),
  state TEXT NOT NULL CHECK(state IN ('effect_committed','outcome_unknown','finalized')),
  fence_epoch BIGINT NOT NULL CHECK(fence_epoch>0),
  owner_evidence_ref TEXT,
  committed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(attempt_authorization_ref,site_ref),
  UNIQUE(attempt_authorization_ref,site_ref,authorization_segment_ref),
  UNIQUE(site_ref,producer_kind,producer_context,producer_generation,attempt_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(budget_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref,credit_account_ref,unit),
  CHECK((state='effect_committed' AND owner_evidence_ref IS NULL)
    OR (state IN ('outcome_unknown','finalized') AND length(owner_evidence_ref) BETWEEN 1 AND 256)),
  CHECK(provisional_customer_amount IS NULL
    OR provisional_customer_amount BETWEEN 0 AND maximum_amount)
);
CREATE INDEX credit_usage_attempt_segment_idx
  ON platform.credit_usage_attempt_intent(site_ref,authorization_segment_ref,state);

CREATE TABLE platform.credit_attempt_usage_evidence (
  evidence_ref UUID PRIMARY KEY,
  attempt_authorization_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  budget_allocation_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  execution_manifest_ref TEXT NOT NULL CHECK(length(execution_manifest_ref) BETWEEN 1 AND 256),
  producer_kind TEXT NOT NULL CHECK(producer_kind IN ('model_gateway','capability_runtime','job_runtime')),
  producer_context TEXT NOT NULL CHECK(length(producer_context) BETWEEN 1 AND 256),
  producer_generation BIGINT NOT NULL CHECK(producer_generation>0),
  attempt_ref TEXT NOT NULL CHECK(length(attempt_ref) BETWEEN 1 AND 256),
  logical_effect_ref TEXT NOT NULL CHECK(length(logical_effect_ref) BETWEEN 1 AND 256),
  revision BIGINT NOT NULL CHECK(revision>0),
  correction_of_evidence_ref UUID,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('measured','zero','unavailable')),
  attempt_outcome TEXT NOT NULL CHECK(attempt_outcome IN (
    'succeeded','failed_before_effect','failed_after_effect','canceled_before_effect','canceled_after_effect'
  )),
  source_digest CHAR(64) NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
  evidence JSONB NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  evidence_digest CHAR(64) NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(evidence_ref,site_ref),
  UNIQUE(evidence_ref,site_ref,authorization_segment_ref,producer_kind,producer_context,producer_generation,attempt_ref,revision),
  UNIQUE(site_ref,producer_kind,producer_context,producer_generation,attempt_ref,revision),
  FOREIGN KEY(attempt_authorization_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_attempt_intent(attempt_authorization_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(budget_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(correction_of_evidence_ref,site_ref)
    REFERENCES platform.credit_attempt_usage_evidence(evidence_ref,site_ref)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(
    (revision=1 AND correction_of_evidence_ref IS NULL)
    OR (revision>1 AND correction_of_evidence_ref IS NOT NULL)
  )
);
CREATE INDEX credit_attempt_usage_segment_idx
  ON platform.credit_attempt_usage_evidence(site_ref,authorization_segment_ref,attempt_ref,revision DESC);

CREATE TABLE platform.credit_usage_segment_closure (
  closure_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  budget_allocation_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  execution_manifest_ref TEXT NOT NULL CHECK(length(execution_manifest_ref) BETWEEN 1 AND 256),
  closure_revision BIGINT NOT NULL CHECK(closure_revision>0),
  correction_of_closure_ref UUID,
  expected_evidence_count INTEGER NOT NULL CHECK(expected_evidence_count BETWEEN 1 AND 4096),
  evidence_set_digest CHAR(64) NOT NULL CHECK(evidence_set_digest ~ '^[a-f0-9]{64}$'),
  closure_digest CHAR(64) NOT NULL CHECK(closure_digest ~ '^[a-f0-9]{64}$'),
  closed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(closure_ref,site_ref),
  UNIQUE(closure_ref,site_ref,authorization_segment_ref,closure_revision),
  UNIQUE(site_ref,authorization_segment_ref,closure_revision),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(budget_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(credit_hold_ref,site_ref)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref),
  FOREIGN KEY(correction_of_closure_ref,site_ref)
    REFERENCES platform.credit_usage_segment_closure(closure_ref,site_ref)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK(
    (closure_revision=1 AND correction_of_closure_ref IS NULL)
    OR (closure_revision>1 AND correction_of_closure_ref IS NOT NULL)
  )
);

CREATE TABLE platform.credit_usage_closure_evidence (
  closure_ref UUID NOT NULL,
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  evidence_ref UUID NOT NULL,
  evidence_ordinal INTEGER NOT NULL CHECK(evidence_ordinal>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(closure_ref,evidence_ordinal),
  UNIQUE(closure_ref,evidence_ref),
  FOREIGN KEY(closure_ref,site_ref)
    REFERENCES platform.credit_usage_segment_closure(closure_ref,site_ref),
  FOREIGN KEY(evidence_ref,site_ref)
    REFERENCES platform.credit_attempt_usage_evidence(evidence_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref)
);

CREATE TABLE platform.credit_usage_settlement (
  settlement_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  execution_budget_root_ref UUID NOT NULL,
  budget_allocation_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  closure_ref UUID NOT NULL,
  closure_revision BIGINT NOT NULL CHECK(closure_revision>0),
  prior_settlement_ref UUID,
  rating_snapshot_ref UUID NOT NULL,
  policy_rated_amount NUMERIC(38,0) NOT NULL CHECK(policy_rated_amount>=0),
  segment_maximum_amount NUMERIC(38,0) NOT NULL CHECK(segment_maximum_amount>0),
  customer_amount NUMERIC(38,0) NOT NULL CHECK(customer_amount>=0),
  platform_exposure_amount NUMERIC(38,0) NOT NULL CHECK(platform_exposure_amount>=0),
  journal_transaction_ref UUID,
  settled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(settlement_ref,site_ref),
  UNIQUE(settlement_ref,site_ref,authorization_segment_ref),
  UNIQUE(site_ref,closure_ref),
  FOREIGN KEY(execution_budget_root_ref,site_ref)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(budget_allocation_ref,site_ref)
    REFERENCES platform.credit_budget_allocation(budget_allocation_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(credit_hold_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold(credit_hold_ref,site_ref,credit_account_ref,unit),
  FOREIGN KEY(closure_ref,site_ref,authorization_segment_ref,closure_revision)
    REFERENCES platform.credit_usage_segment_closure(closure_ref,site_ref,authorization_segment_ref,closure_revision),
  FOREIGN KEY(prior_settlement_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(rating_snapshot_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_rating_snapshot(rating_snapshot_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(journal_transaction_ref,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_journal_transaction(journal_transaction_ref,site_ref,credit_account_ref,unit),
  CHECK(customer_amount<=segment_maximum_amount),
  CHECK(platform_exposure_amount=policy_rated_amount-customer_amount),
  CHECK(prior_settlement_ref IS NOT NULL
    OR (customer_amount=0 AND journal_transaction_ref IS NULL)
    OR (customer_amount>0 AND journal_transaction_ref IS NOT NULL))
);

CREATE TABLE platform.credit_rated_usage (
  rated_usage_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  closure_ref UUID NOT NULL,
  settlement_ref UUID NOT NULL,
  rating_snapshot_ref UUID NOT NULL,
  evidence_ref UUID NOT NULL,
  attempt_ref TEXT NOT NULL CHECK(length(attempt_ref) BETWEEN 1 AND 256),
  policy_rated_amount NUMERIC(38,0) NOT NULL CHECK(policy_rated_amount>=0),
  line_items JSONB NOT NULL CHECK(jsonb_typeof(line_items)='array'),
  rated_usage_digest CHAR(64) NOT NULL CHECK(rated_usage_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,closure_ref,evidence_ref),
  FOREIGN KEY(settlement_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(rating_snapshot_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_rating_snapshot(rating_snapshot_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(evidence_ref,site_ref)
    REFERENCES platform.credit_attempt_usage_evidence(evidence_ref,site_ref)
);

CREATE TABLE platform.credit_usage_settlement_source (
  settlement_ref UUID NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK(source_ordinal>=0),
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  credit_hold_ref UUID NOT NULL,
  credit_grant_id UUID NOT NULL,
  credit_account_ref UUID NOT NULL,
  unit TEXT NOT NULL CHECK(length(unit) BETWEEN 1 AND 64),
  allocation_ordinal INTEGER NOT NULL CHECK(allocation_ordinal>=0),
  direction TEXT NOT NULL CHECK(direction IN ('capture','increase','decrease')),
  amount NUMERIC(38,0) NOT NULL CHECK(amount>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(settlement_ref,source_ordinal),
  UNIQUE(settlement_ref,credit_grant_id,direction),
  FOREIGN KEY(settlement_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref,authorization_segment_ref),
  FOREIGN KEY(credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit)
    REFERENCES platform.credit_hold_allocation(
      credit_hold_ref,credit_grant_id,site_ref,credit_account_ref,unit
    )
);

CREATE TABLE platform.credit_usage_variance (
  variance_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  settlement_ref UUID NOT NULL,
  policy_rated_amount NUMERIC(38,0) NOT NULL CHECK(policy_rated_amount>0),
  customer_amount NUMERIC(38,0) NOT NULL CHECK(customer_amount>=0),
  platform_exposure_amount NUMERIC(38,0) NOT NULL CHECK(platform_exposure_amount>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,settlement_ref),
  FOREIGN KEY(settlement_ref,site_ref,authorization_segment_ref)
    REFERENCES platform.credit_usage_settlement(settlement_ref,site_ref,authorization_segment_ref),
  CHECK(platform_exposure_amount=policy_rated_amount-customer_amount)
);

CREATE TABLE platform.credit_usage_reconciliation (
  reconciliation_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  closure_ref UUID NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('usage_unavailable','required_dimension_missing')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,closure_ref),
  FOREIGN KEY(closure_ref,site_ref)
    REFERENCES platform.credit_usage_segment_closure(closure_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_ref)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref)
);

CREATE TABLE platform.credit_usage_command_receipt (
  receipt_ref UUID PRIMARY KEY,
  site_ref TEXT NOT NULL REFERENCES platform.authorization_site(site_ref),
  operation_kind TEXT NOT NULL CHECK(operation_kind IN (
    'prepare_attempt','attempt_unknown','finalize_attempt','settle_usage'
  )),
  business_operation_key TEXT NOT NULL CHECK(length(business_operation_key) BETWEEN 1 AND 256),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('accepted','reconciliation_required')),
  result JSONB NOT NULL CHECK(jsonb_typeof(result)='object'),
  result_digest CHAR(64) NOT NULL CHECK(result_digest ~ '^[a-f0-9]{64}$'),
  outbox_event_ref UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id),
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_ref,operation_kind,business_operation_key)
);

CREATE FUNCTION platform.reject_credit_usage_fact_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  RAISE EXCEPTION 'CREDIT_USAGE_FACT_IMMUTABLE' USING ERRCODE='23000';
END $$;

CREATE FUNCTION platform.guard_credit_usage_attempt_transition() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.site_ref IS DISTINCT FROM OLD.site_ref
    OR NEW.execution_budget_root_ref IS DISTINCT FROM OLD.execution_budget_root_ref
    OR NEW.budget_allocation_ref IS DISTINCT FROM OLD.budget_allocation_ref
    OR NEW.authorization_segment_ref IS DISTINCT FROM OLD.authorization_segment_ref
    OR NEW.credit_hold_ref IS DISTINCT FROM OLD.credit_hold_ref
    OR NEW.credit_account_ref IS DISTINCT FROM OLD.credit_account_ref
    OR NEW.unit IS DISTINCT FROM OLD.unit
    OR NEW.execution_manifest_ref IS DISTINCT FROM OLD.execution_manifest_ref
    OR NEW.producer_kind IS DISTINCT FROM OLD.producer_kind
    OR NEW.producer_context IS DISTINCT FROM OLD.producer_context
    OR NEW.producer_generation IS DISTINCT FROM OLD.producer_generation
    OR NEW.attempt_ref IS DISTINCT FROM OLD.attempt_ref
    OR NEW.logical_effect_ref IS DISTINCT FROM OLD.logical_effect_ref
    OR NEW.maximum_dimensions IS DISTINCT FROM OLD.maximum_dimensions
    OR NEW.maximum_dimensions_digest IS DISTINCT FROM OLD.maximum_dimensions_digest
    OR NEW.maximum_amount IS DISTINCT FROM OLD.maximum_amount
    OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CREDIT_USAGE_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NEW.fence_epoch<>OLD.fence_epoch+1
    OR NOT (
      (OLD.state='effect_committed' AND NEW.state IN ('outcome_unknown','finalized'))
      OR (OLD.state='outcome_unknown' AND NEW.state='finalized')
      OR (OLD.state='finalized' AND NEW.state='finalized')
    ) THEN
    RAISE EXCEPTION 'CREDIT_USAGE_ATTEMPT_TRANSITION_INVALID' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credit_usage_attempt_transition_guard
  BEFORE UPDATE ON platform.credit_usage_attempt_intent
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_usage_attempt_transition();
CREATE TRIGGER credit_usage_attempt_delete_guard
  BEFORE DELETE ON platform.credit_usage_attempt_intent
  FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_usage_fact_mutation();

CREATE FUNCTION platform.assert_credit_usage_closure_complete() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  target_ref UUID := NEW.closure_ref;
  expected_count INTEGER;
  actual_count INTEGER;
  min_ordinal INTEGER;
  max_ordinal INTEGER;
BEGIN
  SELECT expected_evidence_count INTO expected_count
    FROM platform.credit_usage_segment_closure WHERE closure_ref=target_ref;
  SELECT count(*)::INTEGER,min(evidence_ordinal),max(evidence_ordinal)
    INTO actual_count,min_ordinal,max_ordinal
    FROM platform.credit_usage_closure_evidence WHERE closure_ref=target_ref;
  IF expected_count IS NULL OR actual_count<>expected_count OR min_ordinal<>0 OR max_ordinal<>expected_count-1 THEN
    RAISE EXCEPTION 'CREDIT_USAGE_CLOSURE_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER credit_usage_closure_complete_from_closure
  AFTER INSERT ON platform.credit_usage_segment_closure
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION platform.assert_credit_usage_closure_complete();
CREATE CONSTRAINT TRIGGER credit_usage_closure_complete_from_evidence
  AFTER INSERT ON platform.credit_usage_closure_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION platform.assert_credit_usage_closure_complete();

DO $$
DECLARE relation_name TEXT;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'credit_rating_policy_revision','credit_rating_snapshot','credit_attempt_usage_evidence',
    'credit_usage_segment_closure','credit_usage_closure_evidence','credit_rated_usage',
    'credit_usage_settlement','credit_usage_settlement_source','credit_usage_variance',
    'credit_usage_reconciliation','credit_usage_command_receipt'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON platform.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_credit_usage_fact_mutation()',
      relation_name||'_immutable',relation_name
    );
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION platform.reject_credit_usage_fact_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.guard_credit_usage_attempt_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_usage_closure_complete() FROM PUBLIC;
