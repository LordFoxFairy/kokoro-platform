-- Upgrade already-migrated databases to the permanent Model Gateway dispatch
-- authority and terminal-record fence. The original migration is immutable.
-- Existing duplicate terminal frames are corruption: index creation deliberately
-- fails instead of choosing or deleting owner evidence during migration.
CREATE UNIQUE INDEX model_gateway_frame_one_terminal_idx
ON platform.model_gateway_frame(site_ref,invocation_ref) WHERE terminal;

CREATE OR REPLACE FUNCTION platform.guard_model_gateway_invocation_transition() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, platform
AS $$
BEGIN
  IF OLD.site_ref IS DISTINCT FROM NEW.site_ref
     OR OLD.invocation_ref IS DISTINCT FROM NEW.invocation_ref
     OR OLD.authorization_handle IS DISTINCT FROM NEW.authorization_handle
     OR OLD.execution_manifest_ref IS DISTINCT FROM NEW.execution_manifest_ref
     OR OLD.authorization_segment_ref IS DISTINCT FROM NEW.authorization_segment_ref
     OR OLD.logical_call_ref IS DISTINCT FROM NEW.logical_call_ref
     OR OLD.attempt_ref IS DISTINCT FROM NEW.attempt_ref
     OR OLD.producer_context IS DISTINCT FROM NEW.producer_context
     OR OLD.producer_generation IS DISTINCT FROM NEW.producer_generation
     OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
     OR OLD.request_envelope IS DISTINCT FROM NEW.request_envelope
     OR OLD.gateway_model IS DISTINCT FROM NEW.gateway_model
     OR OLD.maximum_dimensions IS DISTINCT FROM NEW.maximum_dimensions
     OR OLD.attempt_authorization_ref IS DISTINCT FROM NEW.attempt_authorization_ref
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_IDENTITY_IMMUTABLE';
  END IF;
  IF NOT (
    (OLD.state='queued' AND NEW.state='dispatching')
    OR (OLD.state='dispatching' AND NEW.state IN ('succeeded','failed','outcome_unknown'))
    OR (OLD.state='outcome_unknown' AND NEW.state IN ('succeeded','failed'))
    OR (OLD.state=NEW.state AND OLD.state IN ('dispatching','succeeded','failed','outcome_unknown'))
  ) THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_TRANSITION_INVALID';
  END IF;
  IF OLD.state IN ('dispatching','succeeded','failed','outcome_unknown') AND (
    NEW.dispatch_owner_ref IS DISTINCT FROM OLD.dispatch_owner_ref
    OR NEW.dispatch_fence IS DISTINCT FROM OLD.dispatch_fence
    OR (NEW.state='dispatching'
      AND NEW.dispatch_lease_expires_at<OLD.dispatch_lease_expires_at)
  ) THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_DISPATCH_AUTHORITY_INVALID';
  END IF;
  IF OLD.state IN ('succeeded','failed','outcome_unknown') AND NEW.state=OLD.state THEN
    IF NEW.response_envelope IS DISTINCT FROM OLD.response_envelope
       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
       OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
       OR NEW.owner_evidence_ref IS DISTINCT FROM OLD.owner_evidence_ref
       OR NEW.fence_epoch IS DISTINCT FROM OLD.fence_epoch
       OR NEW.dispatch_owner_ref IS DISTINCT FROM OLD.dispatch_owner_ref
       OR NEW.dispatch_fence IS DISTINCT FROM OLD.dispatch_fence
       OR NEW.dispatch_lease_expires_at IS DISTINCT FROM OLD.dispatch_lease_expires_at
    THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_TERMINAL_IMMUTABLE';
    END IF;
    IF NEW.last_frame_sequence<>OLD.last_frame_sequence+1
       OR NEW.frame_count<>OLD.frame_count+1
       OR NEW.total_frame_bytes<=OLD.total_frame_bytes
       OR NEW.last_frame_digest IS NOT DISTINCT FROM OLD.last_frame_digest
    THEN RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_TERMINAL_FRAME_INVALID';
    END IF;
  END IF;
  IF (
    OLD.state='queued' AND NEW.state='dispatching'
    AND (NEW.fence_epoch<>OLD.fence_epoch OR NEW.dispatch_fence<>OLD.dispatch_fence+1)
  ) OR (
    OLD.state='dispatching' AND NEW.state IN ('succeeded','failed','outcome_unknown')
    AND NEW.fence_epoch<>OLD.fence_epoch+1
  ) OR (
    OLD.state='outcome_unknown' AND NEW.state IN ('succeeded','failed')
    AND NEW.fence_epoch<>OLD.fence_epoch+1
  ) OR (
    OLD.state=NEW.state AND NEW.fence_epoch<>OLD.fence_epoch
  ) OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'MODEL_GATEWAY_INVOCATION_FENCE_INVALID';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION platform.guard_model_gateway_invocation_transition() FROM PUBLIC;
