-- Fresh-data-only Credit authority for Media child allocation derivation and return.
-- This unreleased schema intentionally has no legacy job/receipt migration path. Reset
-- development data before applying it when the stable preflight error is raised.

BEGIN;

SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '30s';

-- This is the first database operation after transaction-local safety settings. Never
-- silently rewrite or delete authority history to make an unsupported database fit.
DO $migration_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform.credit_budget_allocation AS allocation
    WHERE allocation.audience='job'
  ) OR EXISTS (
    SELECT 1 FROM platform.credit_allocation_reservation_receipt
  ) OR EXISTS (
    SELECT 1 FROM platform.credit_allocation_return_receipt
  ) THEN
    RAISE EXCEPTION 'CREDIT_MEDIA_CHILD_MIGRATION_REQUIRES_FRESH_DATA'
      USING ERRCODE='P0001',
            HINT='Reset unsupported pre-release Credit development data before applying this migration.';
  END IF;
END $migration_preflight$;

ALTER TABLE platform.credit_budget_allocation
  ADD COLUMN capability_key TEXT CHECK(
    capability_key IS NULL OR length(capability_key) BETWEEN 1 AND 256
  ),
  ADD COLUMN expires_at TIMESTAMPTZ;

ALTER TABLE platform.credit_budget_allocation
  DROP CONSTRAINT credit_budget_allocation_audience_check,
  ADD CONSTRAINT credit_budget_allocation_audience_check CHECK(audience IN (
    'root','model_gateway','capability_runtime','media','agent_team','target_runtime'
  )),
  ADD CONSTRAINT credit_media_child_allocation_metadata_check CHECK(
    audience<>'media'
    OR (
      NOT is_root
      AND purpose='media_operation'
      AND surface_ref IS NOT NULL
      AND capability_key IS NOT NULL
      AND operation_ref IS NOT NULL
      AND expires_at IS NOT NULL
    )
  );

ALTER TABLE platform.credit_allocation_reservation_receipt
  ADD COLUMN parent_expected_epoch BIGINT CHECK(parent_expected_epoch IS NULL OR parent_expected_epoch>0),
  ADD COLUMN child_initial_epoch BIGINT CHECK(child_initial_epoch IS NULL OR child_initial_epoch>0),
  ADD COLUMN media_operation_ref TEXT CHECK(
    media_operation_ref IS NULL OR length(media_operation_ref) BETWEEN 1 AND 256
  ),
  ADD COLUMN audience TEXT,
  ADD COLUMN purpose TEXT CHECK(purpose IS NULL OR length(purpose) BETWEEN 1 AND 128),
  ADD COLUMN surface_ref TEXT CHECK(surface_ref IS NULL OR length(surface_ref) BETWEEN 1 AND 256),
  ADD COLUMN capability_key TEXT CHECK(capability_key IS NULL OR length(capability_key) BETWEEN 1 AND 256),
  ADD COLUMN agent_ref TEXT CHECK(agent_ref IS NULL OR length(agent_ref) BETWEEN 1 AND 256),
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD CONSTRAINT credit_allocation_reservation_audience_check CHECK(
    audience IS NULL OR audience IN (
      'model_gateway','capability_runtime','media','agent_team','target_runtime'
    )
  ),
  ADD CONSTRAINT credit_media_allocation_reservation_metadata_check CHECK(
    audience IS DISTINCT FROM 'media'
    OR (
      parent_expected_epoch IS NOT NULL
      AND child_initial_epoch IS NOT NULL
      AND purpose='media_operation'
      AND media_operation_ref IS NOT NULL
      AND surface_ref IS NOT NULL
      AND capability_key IS NOT NULL
      AND expires_at IS NOT NULL
    )
  );

ALTER TABLE platform.credit_allocation_return_receipt
  ADD COLUMN parent_expected_revision BIGINT CHECK(
    parent_expected_revision IS NULL OR parent_expected_revision>0
  ),
  ADD COLUMN parent_expected_epoch BIGINT CHECK(parent_expected_epoch IS NULL OR parent_expected_epoch>0),
  ADD COLUMN child_expected_revision BIGINT CHECK(child_expected_revision IS NULL OR child_expected_revision>0),
  ADD COLUMN child_expected_epoch BIGINT CHECK(child_expected_epoch IS NULL OR child_expected_epoch>=0),
  ADD COLUMN audience TEXT,
  ADD COLUMN media_operation_ref TEXT CHECK(
    media_operation_ref IS NULL OR length(media_operation_ref) BETWEEN 1 AND 256
  ),
  ADD COLUMN owner_closure_evidence_ref TEXT CHECK(
    owner_closure_evidence_ref IS NULL OR length(owner_closure_evidence_ref) BETWEEN 1 AND 256
  ),
  ADD COLUMN captured_amount NUMERIC(38,0) CHECK(captured_amount IS NULL OR captured_amount>=0),
  ADD COLUMN owner_closure_outcome TEXT CHECK(
    owner_closure_outcome IS NULL OR owner_closure_outcome IN ('completed','partial','failed','canceled')
  ),
  ADD COLUMN root_state_at_return TEXT CHECK(
    root_state_at_return IS NULL OR root_state_at_return IN ('open','closing')
  ),
  ADD CONSTRAINT credit_allocation_return_audience_check CHECK(
    audience IS NULL OR audience IN (
      'model_gateway','capability_runtime','media','agent_team','target_runtime'
    )
  ),
  ADD CONSTRAINT credit_media_child_return_revision_check CHECK(
    audience IS DISTINCT FROM 'media'
    OR (
      parent_resulting_revision=parent_expected_revision+1
      AND child_terminal_revision=child_expected_revision+1
      AND fence_epoch=child_expected_epoch+1
    )
  ),
  ADD CONSTRAINT credit_media_child_return_metadata_check CHECK(
    audience IS DISTINCT FROM 'media'
    OR (
      parent_expected_revision IS NOT NULL
      AND parent_expected_epoch IS NOT NULL
      AND child_expected_revision IS NOT NULL
      AND child_expected_epoch IS NOT NULL
      AND media_operation_ref IS NOT NULL
      AND owner_closure_evidence_ref IS NOT NULL
      AND captured_amount IS NOT NULL
      AND owner_closure_outcome IS NOT NULL
      AND root_state_at_return IS NOT NULL
      AND (
        (root_state_at_return='closing' AND reason='root_closing')
        OR (
          root_state_at_return='open'
          AND (
            (reason='completed' AND owner_closure_outcome='completed')
            OR (reason='canceled_before_effect'
              AND owner_closure_outcome='canceled' AND captured_amount=0)
            OR (reason='fenced_recovery' AND (
              owner_closure_outcome IN ('partial','failed')
              OR (owner_closure_outcome='canceled' AND captured_amount>0)
            ))
          )
        )
      )
    )
  );

ALTER TABLE platform.credit_budget_operation_receipt
  DROP CONSTRAINT credit_budget_operation_receipt_operation_kind_check;

ALTER TABLE platform.credit_budget_operation_receipt
  ALTER COLUMN authorization_segment_ref DROP NOT NULL,
  ALTER COLUMN outbox_event_ref DROP NOT NULL,
  ADD COLUMN parent_allocation_ref UUID,
  ADD COLUMN child_allocation_ref UUID,
  ADD COLUMN parent_before_revision BIGINT CHECK(parent_before_revision IS NULL OR parent_before_revision>0),
  ADD COLUMN parent_after_revision BIGINT CHECK(parent_after_revision IS NULL OR parent_after_revision>0),
  ADD COLUMN child_before_revision BIGINT CHECK(child_before_revision IS NULL OR child_before_revision>=0),
  ADD COLUMN child_after_revision BIGINT CHECK(child_after_revision IS NULL OR child_after_revision>0),
  ADD COLUMN credit_amount NUMERIC(38,0) CHECK(credit_amount IS NULL OR credit_amount>=0),
  ADD COLUMN owner_closure_evidence_ref TEXT CHECK(
    owner_closure_evidence_ref IS NULL OR length(owner_closure_evidence_ref) BETWEEN 1 AND 256
  ),
  ADD CONSTRAINT credit_budget_operation_receipt_operation_kind_check CHECK(operation_kind IN (
    'reserve_root','finalize_segment','release_segment','reconcile_segment',
    'derive_media_child','return_media_child'
  )),
  ADD CONSTRAINT credit_budget_operation_receipt_child_scope_check CHECK(
    (
      operation_kind NOT IN ('derive_media_child','return_media_child')
      AND authorization_segment_ref IS NOT NULL
      AND outbox_event_ref IS NOT NULL
      AND parent_allocation_ref IS NULL
      AND child_allocation_ref IS NULL
      AND parent_before_revision IS NULL
      AND parent_after_revision IS NULL
      AND child_before_revision IS NULL
      AND child_after_revision IS NULL
      AND credit_amount IS NULL
      AND owner_closure_evidence_ref IS NULL
    )
    OR (
      operation_kind='derive_media_child'
      AND authorization_segment_ref IS NULL
      AND outbox_event_ref IS NULL
      AND parent_allocation_ref IS NOT NULL
      AND child_allocation_ref IS NOT NULL
      AND parent_before_revision IS NOT NULL
      AND parent_before_revision>0
      AND parent_after_revision IS NOT NULL
      AND parent_after_revision=parent_before_revision+1
      AND child_before_revision IS NOT NULL
      AND child_before_revision=0
      AND child_after_revision IS NOT NULL
      AND child_after_revision=1
      AND credit_amount IS NOT NULL
      AND credit_amount>0
      AND owner_closure_evidence_ref IS NULL
    )
    OR (
      operation_kind='return_media_child'
      AND authorization_segment_ref IS NULL
      AND outbox_event_ref IS NULL
      AND parent_allocation_ref IS NOT NULL
      AND child_allocation_ref IS NOT NULL
      AND parent_before_revision IS NOT NULL
      AND parent_before_revision>0
      AND parent_after_revision IS NOT NULL
      AND parent_after_revision=parent_before_revision+1
      AND child_before_revision IS NOT NULL
      AND child_before_revision>0
      AND child_after_revision IS NOT NULL
      AND child_after_revision=child_before_revision+1
      AND credit_amount IS NOT NULL
      AND credit_amount>=0
      AND owner_closure_evidence_ref IS NOT NULL
    )
  ),
  ADD FOREIGN KEY(parent_allocation_ref,parent_before_revision)
    REFERENCES platform.credit_budget_allocation_revision(budget_allocation_ref,revision) MATCH FULL,
  ADD FOREIGN KEY(parent_allocation_ref,parent_after_revision)
    REFERENCES platform.credit_budget_allocation_revision(budget_allocation_ref,revision) MATCH FULL,
  ADD FOREIGN KEY(child_allocation_ref,child_after_revision)
    REFERENCES platform.credit_budget_allocation_revision(budget_allocation_ref,revision) MATCH FULL;

CREATE INDEX credit_budget_operation_receipt_return_child_latest_idx
  ON platform.credit_budget_operation_receipt(site_ref,child_allocation_ref,completed_at DESC)
  WHERE operation_kind='return_media_child';

CREATE FUNCTION platform.guard_credit_media_allocation_metadata_update() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
BEGIN
  IF ROW(OLD.capability_key,OLD.expires_at)
     IS DISTINCT FROM ROW(NEW.capability_key,NEW.expires_at) THEN
    RAISE EXCEPTION 'CREDIT_MEDIA_CHILD_METADATA_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER credit_media_allocation_metadata_update_guard
  BEFORE UPDATE ON platform.credit_budget_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.guard_credit_media_allocation_metadata_update();

CREATE FUNCTION platform.assert_credit_media_child_receipt_metadata() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,platform AS $$
DECLARE
  child_fact platform.credit_budget_allocation%ROWTYPE;
  parent_fact platform.credit_budget_allocation%ROWTYPE;
  root_fact platform.credit_execution_budget_root%ROWTYPE;
  hold_fact platform.credit_hold%ROWTYPE;
  parent_before platform.credit_budget_allocation_revision%ROWTYPE;
  parent_after platform.credit_budget_allocation_revision%ROWTYPE;
  child_before platform.credit_budget_allocation_revision%ROWTYPE;
  child_after platform.credit_budget_allocation_revision%ROWTYPE;
BEGIN
  IF NEW.audience IS DISTINCT FROM 'media' THEN RETURN NULL; END IF;

  SELECT * INTO child_fact FROM platform.credit_budget_allocation
  WHERE budget_allocation_ref=NEW.child_allocation_ref AND site_ref=NEW.site_ref;
  SELECT * INTO parent_fact FROM platform.credit_budget_allocation
  WHERE budget_allocation_ref=NEW.parent_allocation_ref AND site_ref=NEW.site_ref;
  SELECT * INTO root_fact FROM platform.credit_execution_budget_root
  WHERE execution_budget_root_ref=NEW.execution_budget_root_ref AND site_ref=NEW.site_ref;
  SELECT * INTO hold_fact FROM platform.credit_hold
  WHERE credit_hold_ref=root_fact.credit_hold_ref AND site_ref=NEW.site_ref;

  IF child_fact.budget_allocation_ref IS NULL
     OR parent_fact.budget_allocation_ref IS NULL
     OR root_fact.execution_budget_root_ref IS NULL
     OR hold_fact.credit_hold_ref IS NULL
     OR child_fact.parent_allocation_ref IS DISTINCT FROM NEW.parent_allocation_ref
     OR child_fact.execution_budget_root_ref IS DISTINCT FROM NEW.execution_budget_root_ref
     OR parent_fact.execution_budget_root_ref IS DISTINCT FROM NEW.execution_budget_root_ref
     OR root_fact.root_allocation_ref IS DISTINCT FROM NEW.parent_allocation_ref
     OR hold_fact.credit_hold_ref IS DISTINCT FROM root_fact.credit_hold_ref
     OR hold_fact.execution_root_ref IS DISTINCT FROM root_fact.execution_root_ref
     OR NOT parent_fact.is_root OR parent_fact.audience<>'root' THEN
    RAISE EXCEPTION 'CREDIT_MEDIA_CHILD_LINEAGE_INVALID' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME='credit_allocation_reservation_receipt' THEN
    SELECT * INTO parent_before FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_expected_revision;
    SELECT * INTO parent_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_resulting_revision;
    SELECT * INTO child_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.child_allocation_ref AND revision=NEW.child_initial_revision;
    IF root_fact.state<>'open'
       OR hold_fact.state<>'open'
       OR parent_before.allocation_epoch IS DISTINCT FROM NEW.parent_expected_epoch
       OR parent_after.allocation_epoch IS DISTINCT FROM NEW.parent_expected_epoch
       OR child_after.allocation_epoch IS DISTINCT FROM NEW.child_initial_epoch
       OR child_fact.audience IS DISTINCT FROM NEW.audience
       OR child_fact.purpose IS DISTINCT FROM NEW.purpose
       OR child_fact.operation_ref IS DISTINCT FROM NEW.media_operation_ref
       OR child_fact.surface_ref IS DISTINCT FROM NEW.surface_ref
       OR child_fact.capability_key IS DISTINCT FROM NEW.capability_key
       OR child_fact.agent_ref IS DISTINCT FROM NEW.agent_ref
       OR child_fact.expires_at IS DISTINCT FROM NEW.expires_at THEN
      RAISE EXCEPTION 'CREDIT_MEDIA_CHILD_RESERVATION_METADATA_INVALID' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO parent_before FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_expected_revision;
    SELECT * INTO parent_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.parent_allocation_ref AND revision=NEW.parent_resulting_revision;
    SELECT * INTO child_before FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.child_allocation_ref AND revision=NEW.child_expected_revision;
    SELECT * INTO child_after FROM platform.credit_budget_allocation_revision
    WHERE budget_allocation_ref=NEW.child_allocation_ref AND revision=NEW.child_terminal_revision;
    IF root_fact.state IS DISTINCT FROM NEW.root_state_at_return
       OR root_fact.state NOT IN ('open','closing')
       OR hold_fact.state NOT IN ('open','closing')
       OR NEW.parent_resulting_revision<>NEW.parent_expected_revision+1
       OR NEW.child_terminal_revision<>NEW.child_expected_revision+1
       OR parent_before.allocation_epoch IS DISTINCT FROM NEW.parent_expected_epoch
       OR parent_after.allocation_epoch IS DISTINCT FROM NEW.parent_expected_epoch
       OR child_before.allocation_epoch IS DISTINCT FROM NEW.child_expected_epoch
       OR child_after.allocation_epoch IS DISTINCT FROM NEW.fence_epoch
       OR NEW.fence_epoch<>NEW.child_expected_epoch+1
       OR child_fact.audience<>'media'
       OR child_fact.purpose<>'media_operation'
       OR child_fact.operation_ref IS DISTINCT FROM NEW.media_operation_ref
       OR child_after.captured_cumulative IS DISTINCT FROM NEW.captured_amount
       OR EXISTS (
         SELECT 1 FROM platform.credit_authorization_segment AS segment
         WHERE segment.site_ref=NEW.site_ref
           AND segment.budget_allocation_ref=NEW.child_allocation_ref
           AND segment.state NOT IN ('settled','released','expired')
       ) THEN
      RAISE EXCEPTION 'CREDIT_MEDIA_CHILD_RETURN_FENCE_INVALID' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER credit_media_child_reservation_metadata
  AFTER INSERT ON platform.credit_allocation_reservation_receipt
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_media_child_receipt_metadata();

CREATE CONSTRAINT TRIGGER credit_media_child_return_metadata
  AFTER INSERT ON platform.credit_allocation_return_receipt
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.assert_credit_media_child_receipt_metadata();

REVOKE ALL ON FUNCTION platform.guard_credit_media_allocation_metadata_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.assert_credit_media_child_receipt_metadata() FROM PUBLIC;

COMMIT;
