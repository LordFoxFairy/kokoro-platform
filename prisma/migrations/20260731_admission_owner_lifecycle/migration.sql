SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.admission_session_execution_binding (
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  binding_ref TEXT NOT NULL CHECK(length(binding_ref) BETWEEN 1 AND 256),
  namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 256),
  thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 256),
  capability_snapshot_ref TEXT NOT NULL CHECK(length(capability_snapshot_ref) BETWEEN 1 AND 256),
  configuration_revision_id TEXT NOT NULL CHECK(length(configuration_revision_id) BETWEEN 1 AND 256),
  binding_digest CHAR(64) NOT NULL CHECK(binding_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,session_id),
  UNIQUE(binding_ref,site_id),
  FOREIGN KEY(site_id) REFERENCES platform.site(site_ref),
  FOREIGN KEY(configuration_revision_id,site_id)
    REFERENCES platform.site_release(release_ref,site_ref)
);

CREATE TABLE platform.admission_execution_manifest (
  site_id TEXT NOT NULL,
  manifest_ref TEXT NOT NULL CHECK(length(manifest_ref) BETWEEN 1 AND 256),
  manifest_digest CHAR(64) NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 256),
  launch_id TEXT NOT NULL CHECK(length(launch_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL CHECK(length(run_id) BETWEEN 1 AND 256),
  command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128),
  request_digest CHAR(64) NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  trigger_message_id TEXT NOT NULL CHECK(length(trigger_message_id) BETWEEN 1 AND 256),
  binding_ref TEXT NOT NULL CHECK(length(binding_ref) BETWEEN 1 AND 256),
  model_option_revision_ref TEXT NOT NULL CHECK(length(model_option_revision_ref) BETWEEN 1 AND 256),
  resolved_runtime JSONB NOT NULL CHECK(jsonb_typeof(resolved_runtime)='object'),
  execution_budget_root_ref UUID NOT NULL,
  root_hold_ref UUID NOT NULL,
  authorization_segment_ref UUID NOT NULL,
  segment_version BIGINT NOT NULL CHECK(segment_version > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  maximum_expires_at TIMESTAMPTZ NOT NULL,
  capability_snapshot_ref TEXT NOT NULL CHECK(length(capability_snapshot_ref) BETWEEN 1 AND 256),
  configuration_revision_id TEXT NOT NULL CHECK(length(configuration_revision_id) BETWEEN 1 AND 256),
  attachment_refs JSONB NOT NULL CHECK(jsonb_typeof(attachment_refs)='array'),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','committed','released','expired','reconciliation_required','settled'
  )),
  resolution_ref TEXT CHECK(resolution_ref IS NULL OR length(resolution_ref) BETWEEN 1 AND 256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,manifest_ref),
  UNIQUE(site_id,launch_id),
  UNIQUE(site_id,run_id),
  UNIQUE(site_id,authorization_segment_ref),
  FOREIGN KEY(binding_ref,site_id)
    REFERENCES platform.admission_session_execution_binding(binding_ref,site_id),
  FOREIGN KEY(execution_budget_root_ref,site_id)
    REFERENCES platform.credit_execution_budget_root(execution_budget_root_ref,site_ref),
  FOREIGN KEY(authorization_segment_ref,site_id)
    REFERENCES platform.credit_authorization_segment(authorization_segment_ref,site_ref),
  FOREIGN KEY(configuration_revision_id,site_id)
    REFERENCES platform.site_release(release_ref,site_ref),
  CHECK(expires_at <= maximum_expires_at),
  CHECK(
    (state IN ('reserved','committed','expired','reconciliation_required','settled') AND resolution_ref IS NULL)
    OR (state='released' AND resolution_ref IS NOT NULL)
  )
);
CREATE INDEX admission_execution_manifest_reconcile_idx
  ON platform.admission_execution_manifest(state,updated_at,site_id)
  WHERE state IN ('reserved','committed','reconciliation_required');

CREATE FUNCTION platform.reject_admission_session_binding_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ADMISSION_SESSION_EXECUTION_BINDING_IMMUTABLE';
END;
$$;
REVOKE ALL ON FUNCTION platform.reject_admission_session_binding_mutation() FROM PUBLIC;
CREATE TRIGGER admission_session_execution_binding_immutable
BEFORE UPDATE OR DELETE ON platform.admission_session_execution_binding
FOR EACH ROW EXECUTE FUNCTION platform.reject_admission_session_binding_mutation();

CREATE FUNCTION platform.guard_admission_execution_manifest_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.site_id,OLD.manifest_ref,OLD.manifest_digest,OLD.session_id,OLD.launch_id,OLD.run_id,
         OLD.command_id,OLD.request_digest,OLD.trigger_message_id,OLD.binding_ref,
         OLD.model_option_revision_ref,OLD.resolved_runtime,OLD.execution_budget_root_ref,
         OLD.root_hold_ref,OLD.authorization_segment_ref,OLD.expires_at,OLD.maximum_expires_at,
         OLD.capability_snapshot_ref,OLD.configuration_revision_id,OLD.attachment_refs,OLD.created_at)
     IS DISTINCT FROM
     ROW(NEW.site_id,NEW.manifest_ref,NEW.manifest_digest,NEW.session_id,NEW.launch_id,NEW.run_id,
         NEW.command_id,NEW.request_digest,NEW.trigger_message_id,NEW.binding_ref,
         NEW.model_option_revision_ref,NEW.resolved_runtime,NEW.execution_budget_root_ref,
         NEW.root_hold_ref,NEW.authorization_segment_ref,NEW.expires_at,NEW.maximum_expires_at,
         NEW.capability_snapshot_ref,NEW.configuration_revision_id,NEW.attachment_refs,NEW.created_at) THEN
    RAISE EXCEPTION 'ADMISSION_EXECUTION_MANIFEST_IMMUTABLE';
  END IF;
  IF NEW.segment_version <> OLD.segment_version + 1 THEN
    RAISE EXCEPTION 'ADMISSION_EXECUTION_MANIFEST_VERSION_INVALID';
  END IF;
  IF OLD.state IN ('released','expired','settled') OR
     (OLD.state='reserved' AND NEW.state NOT IN ('committed','released','expired','reconciliation_required','settled')) OR
     (OLD.state='committed' AND NEW.state NOT IN ('reconciliation_required','settled')) OR
     (OLD.state='reconciliation_required' AND NEW.state<>'settled') THEN
    RAISE EXCEPTION 'ADMISSION_EXECUTION_MANIFEST_TRANSITION_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform.guard_admission_execution_manifest_transition() FROM PUBLIC;
CREATE TRIGGER admission_execution_manifest_transition
BEFORE UPDATE ON platform.admission_execution_manifest
FOR EACH ROW EXECUTE FUNCTION platform.guard_admission_execution_manifest_transition();
CREATE FUNCTION platform.reject_admission_execution_manifest_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ADMISSION_EXECUTION_MANIFEST_DELETE_FORBIDDEN';
END;
$$;
REVOKE ALL ON FUNCTION platform.reject_admission_execution_manifest_delete() FROM PUBLIC;
CREATE TRIGGER admission_execution_manifest_no_delete
BEFORE DELETE ON platform.admission_execution_manifest
FOR EACH ROW EXECUTE FUNCTION platform.reject_admission_execution_manifest_delete();

ALTER TABLE platform.admission_session_execution_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_session_execution_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_session_execution_binding_site_scope
  ON platform.admission_session_execution_binding
  USING(site_id=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));

ALTER TABLE platform.admission_execution_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.admission_execution_manifest FORCE ROW LEVEL SECURITY;
CREATE POLICY admission_execution_manifest_site_scope
  ON platform.admission_execution_manifest
  USING(site_id=NULLIF(current_setting('app.site_id',true),''))
  WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));

REVOKE ALL ON
  platform.admission_session_execution_binding,
  platform.admission_execution_manifest
FROM PUBLIC;
