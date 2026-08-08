-- AdminQuery reads two independent approval owners through one UUID-keyset projection.
-- This repository is not launched and has no Site approval data to preserve; fail if
-- a development database contains pre-hard-cut identifiers instead of translating them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform.site_effect_approval) THEN
    RAISE EXCEPTION 'SITE_EFFECT_APPROVAL_UUID_HARD_CUT_REQUIRES_EMPTY_TABLE';
  END IF;
END;
$$;

ALTER TABLE platform.site_effect_approval
  ALTER COLUMN approval_ref TYPE UUID USING approval_ref::UUID,
  ADD COLUMN environment TEXT NOT NULL
    CHECK(environment IN ('development','preview','staging','production')),
  ADD COLUMN region TEXT NOT NULL CHECK(length(region) BETWEEN 1 AND 64);

ALTER TABLE platform.admin_approval
  ADD CONSTRAINT admin_approval_non_lifecycle CHECK(operation NOT IN (
    'site.activation.begin',
    'site.traffic-stop.suspend',
    'site.traffic-stop.decommission'
  ));

CREATE INDEX admin_approval_pending_projection_idx
  ON platform.admin_approval(environment,region,state,admitted_at DESC,approval_ref DESC);
CREATE INDEX site_effect_approval_pending_projection_idx
  ON platform.site_effect_approval(environment,region,state,requested_at DESC,approval_ref DESC);

CREATE OR REPLACE FUNCTION platform.site_effect_approval_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.approval_ref,NEW.site_ref,NEW.environment,NEW.region,NEW.operation,
         NEW.effect_digest,NEW.reason,NEW.command_id,NEW.idempotency_key,NEW.request_digest,
         NEW.maker_subject_ref,NEW.requested_at,NEW.expires_at,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.approval_ref,OLD.site_ref,OLD.environment,OLD.region,OLD.operation,
         OLD.effect_digest,OLD.reason,OLD.command_id,OLD.idempotency_key,OLD.request_digest,
         OLD.maker_subject_ref,OLD.requested_at,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'SITE_EFFECT_APPROVAL_REQUEST_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF (OLD.checker_subject_ref IS NOT NULL OR OLD.decided_at IS NOT NULL)
     AND ROW(NEW.checker_subject_ref,NEW.decided_at)
         IS DISTINCT FROM ROW(OLD.checker_subject_ref,OLD.decided_at) THEN
    RAISE EXCEPTION 'SITE_EFFECT_APPROVAL_CHECKER_EVIDENCE_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF (OLD.consumed_request_id IS NOT NULL OR OLD.consumed_at IS NOT NULL)
     AND ROW(NEW.consumed_request_id,NEW.consumed_at)
         IS DISTINCT FROM ROW(OLD.consumed_request_id,OLD.consumed_at) THEN
    RAISE EXCEPTION 'SITE_EFFECT_APPROVAL_CONSUMPTION_EVIDENCE_IMMUTABLE' USING ERRCODE='23000';
  END IF;
  IF NOT ((OLD.state='pending' AND NEW.state IN ('approved','revoked')) OR
          (OLD.state='approved' AND NEW.state IN ('consumed','revoked')) OR
          (OLD.state='consumed' AND NEW IS NOT DISTINCT FROM OLD) OR
          (OLD.state='revoked' AND NEW IS NOT DISTINCT FROM OLD)) THEN
    RAISE EXCEPTION 'SITE_EFFECT_APPROVAL_TRANSITION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.site_effect_approval_terminal() FROM PUBLIC;

-- The pre-launch hard cut removes the operation-agnostic Site/worker policy. Site approvals are
-- administered only by an authenticated Admin operator and consumed in the same owner command.
DROP POLICY site_effect_approval_scope ON platform.site_effect_approval;

CREATE POLICY site_effect_approval_request_insert
  ON platform.site_effect_approval FOR INSERT
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='site.approval.request'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND maker_subject_ref=current_setting('app.subject_id',true)
    AND state='pending'
    AND checker_subject_ref IS NULL AND decided_at IS NULL
    AND consumed_request_id IS NULL AND consumed_at IS NULL
  );

CREATE POLICY site_effect_approval_request_read
  ON platform.site_effect_approval FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='site.approval.request'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND maker_subject_ref=current_setting('app.subject_id',true)
  );

CREATE POLICY site_effect_approval_approve_read
  ON platform.site_effect_approval FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='site.approval.approve'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND maker_subject_ref<>current_setting('app.subject_id',true)
  );

CREATE POLICY site_effect_approval_approve_update
  ON platform.site_effect_approval FOR UPDATE
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='site.approval.approve'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND maker_subject_ref<>current_setting('app.subject_id',true)
    AND state='pending' AND expires_at>clock_timestamp()
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='site.approval.approve'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND maker_subject_ref<>current_setting('app.subject_id',true)
    AND state='approved'
    AND checker_subject_ref=current_setting('app.subject_id',true)
    AND decided_at IS NOT NULL
    AND consumed_request_id IS NULL AND consumed_at IS NULL
  );

CREATE POLICY site_effect_approval_consume_read
  ON platform.site_effect_approval FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND checker_subject_ref=current_setting('app.subject_id',true)
    AND (
      (state='approved' AND expires_at>clock_timestamp())
      OR
      (state='consumed' AND consumed_request_id IS NOT NULL AND consumed_at IS NOT NULL)
    )
    AND (
      (current_setting('app.operation',true)='site.activation.begin'
       AND operation='site.activation.begin')
      OR
      (current_setting('app.operation',true)='site.traffic-stop.request'
       AND operation IN ('site.traffic-stop.suspend','site.traffic-stop.decommission'))
    )
  );

CREATE POLICY site_effect_approval_consume_update
  ON platform.site_effect_approval FOR UPDATE
  USING (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND checker_subject_ref=current_setting('app.subject_id',true)
    AND state='approved' AND expires_at>clock_timestamp()
    AND (
      (current_setting('app.operation',true)='site.activation.begin'
       AND operation='site.activation.begin')
      OR
      (current_setting('app.operation',true)='site.traffic-stop.request'
       AND operation IN ('site.traffic-stop.suspend','site.traffic-stop.decommission'))
    )
  )
  WITH CHECK (
    current_setting('app.workload_kind',true)='admin_workload'
    AND current_setting('app.actor_kind',true)='operator'
    AND site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND checker_subject_ref=current_setting('app.subject_id',true)
    AND state='consumed'
    AND consumed_request_id IS NOT NULL AND consumed_at IS NOT NULL
    AND (
      (current_setting('app.operation',true)='site.activation.begin'
       AND operation='site.activation.begin')
      OR
      (current_setting('app.operation',true)='site.traffic-stop.request'
       AND operation IN ('site.traffic-stop.suspend','site.traffic-stop.decommission'))
    )
  );

CREATE POLICY admin_approval_query_read
  ON platform.admin_approval FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='admin.approval.list'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR (current_setting('app.admin_scope_kind',true)='site'
          AND target_site_ref IS NOT NULL
          AND current_setting('app.admin_site_refs',true)::JSONB ? target_site_ref)
      OR (current_setting('app.admin_scope_kind',true)='breakglass'
          AND current_setting('app.admin_site_refs',true)::JSONB
              ? ('generic_admin:' || approval_ref::TEXT))
    )
  );

CREATE POLICY site_effect_approval_admin_query_read
  ON platform.site_effect_approval FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND current_setting('app.actor_kind',true)='operator'
    AND current_setting('app.operation',true)='admin.approval.list'
    AND environment=current_setting('app.environment',true)
    AND region=current_setting('app.region',true)
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR (current_setting('app.admin_scope_kind',true)='site'
          AND current_setting('app.admin_site_refs',true)::JSONB ? site_ref)
      OR (current_setting('app.admin_scope_kind',true)='breakglass'
          AND current_setting('app.admin_site_refs',true)::JSONB
              ? ('site_lifecycle:' || approval_ref::TEXT))
    )
  );
