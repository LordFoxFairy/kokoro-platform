SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.runtime_role_identity_authority (
  role_kind TEXT PRIMARY KEY CHECK (role_kind IN (
    'commerce-worker','site-worker','asset-worker','admin-worker',
    'identity-worker','authorization-maintenance'
  )),
  role_name TEXT NOT NULL UNIQUE CHECK (role_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  role_oid BIGINT NOT NULL UNIQUE CHECK (role_oid > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE platform.runtime_role_identity_authority FROM PUBLIC;

CREATE FUNCTION platform.split_worker_role_identity_is_current(p_role_kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM platform.runtime_role_identity_authority authority
    JOIN pg_catalog.pg_roles runtime_role
      ON runtime_role.oid::BIGINT=authority.role_oid
     AND runtime_role.rolname=authority.role_name
    WHERE authority.role_kind=p_role_kind
      AND runtime_role.rolname=SESSION_USER
  )
$function$;
REVOKE ALL ON FUNCTION platform.split_worker_role_identity_is_current(TEXT) FROM PUBLIC;

CREATE FUNCTION platform.lock_asset_worker_upload_completion_authority(
  p_site_ref TEXT,
  p_intent_ref TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT platform.split_worker_role_identity_is_current('asset-worker')
     OR current_setting('app.workload_kind',true)<>'platform_asset_worker'
     OR current_setting('app.operation',true)<>'asset.upload-completion.observe'
     OR current_setting('app.site_id',true)<>p_site_ref THEN
    RAISE EXCEPTION 'ASSET_WORKER_AUTHORITY_FENCE_INVALID' USING ERRCODE='42501';
  END IF;
  PERFORM 1
  FROM platform.asset_upload_intent intent
  JOIN platform.authorization_product_binding binding
    ON binding.workload_identity_id=intent.workload_identity_id
   AND binding.site_ref=intent.site_ref
   AND binding.release_ref=intent.site_release_ref
   AND binding.binding_epoch=intent.binding_epoch
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=intent.subject_ref AND subject.site_ref=binding.site_ref
  JOIN platform.authorization_project project
    ON project.project_ref=intent.project_ref AND project.site_ref=binding.site_ref
  JOIN platform.authorization_project_membership membership
    ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
  WHERE intent.site_ref=p_site_ref AND intent.intent_ref=p_intent_ref
    AND binding.environment=current_setting('app.environment',true)
    AND binding.region=current_setting('app.region',true)
    AND binding.state='active'
    AND subject.subject_generation=intent.subject_generation AND subject.state='active'
    AND project.state='active' AND membership.state='active'
  FOR UPDATE OF intent,binding,subject,project,membership;
  RETURN FOUND;
END
$function$;
REVOKE ALL ON FUNCTION platform.lock_asset_worker_upload_completion_authority(
  TEXT,TEXT
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform.enqueue_asset_upload_completion_event(
  requested_event_id UUID,
  requested_aggregate_id TEXT,
  requested_payload JSONB,
  requested_payload_digest CHAR(64),
  requested_correlation_id TEXT,
  requested_causation_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,platform
AS $function$
BEGIN
  IF current_setting('app.operation',true)<>'asset.multipart.complete'
     OR current_setting('app.workload_kind',true)<>'site_product'
     OR current_setting('app.actor_kind',true)<>'user'
     OR NOT (COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'asset:upload')
     OR jsonb_typeof(requested_payload)<>'object'
     OR (SELECT count(*) FROM jsonb_object_keys(
       CASE WHEN jsonb_typeof(requested_payload)='object' THEN requested_payload ELSE '{}'::JSONB END
     ))<>7
     OR requested_payload->>'kind'<>'asset_upload_completion_requested_v1'
     OR requested_payload->>'siteRef'<>current_setting('app.site_id',true)
     OR requested_payload->>'environment'<>current_setting('app.environment',true)
     OR requested_payload->>'region'<>current_setting('app.region',true)
     OR jsonb_typeof(requested_payload->'intentRef')<>'string'
     OR jsonb_typeof(requested_payload->'sessionRef')<>'string'
     OR jsonb_typeof(requested_payload->'environment')<>'string'
     OR jsonb_typeof(requested_payload->'region')<>'string'
     OR length(requested_payload->>'intentRef') NOT BETWEEN 1 AND 256
     OR length(requested_payload->>'sessionRef') NOT BETWEEN 1 AND 256
     OR length(requested_payload->>'environment') NOT BETWEEN 1 AND 128
     OR length(requested_payload->>'region') NOT BETWEEN 1 AND 128
     OR requested_aggregate_id<>requested_payload->>'sessionRef'
     OR (requested_payload->>'expectedVersion') !~ '^[1-9][0-9]{0,18}$'
     OR requested_payload_digest !~ '^[a-f0-9]{64}$'
     OR length(requested_correlation_id) NOT BETWEEN 1 AND 128
     OR length(requested_causation_id) NOT BETWEEN 1 AND 128
     OR requested_correlation_id ~ '[[:cntrl:]]'
     OR requested_causation_id ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'ASSET_COMPLETION_OUTBOX_EVENT_INVALID' USING ERRCODE='22023';
  END IF;

  INSERT INTO platform.outbox_event
    (event_id,owner,event_type,aggregate_id,payload,payload_digest,correlation_id,causation_id)
  VALUES
    (requested_event_id,'asset','asset.upload.completion.requested',requested_aggregate_id,
     requested_payload,requested_payload_digest,requested_correlation_id,requested_causation_id);
END
$function$;
REVOKE ALL ON FUNCTION platform.enqueue_asset_upload_completion_event(
  UUID,TEXT,JSONB,CHAR(64),TEXT,TEXT
) FROM PUBLIC;

CREATE POLICY asset_upload_intent_worker_completion_lock_function
  ON platform.asset_upload_intent FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('asset-worker')
    AND current_setting('app.workload_kind',true)='platform_asset_worker'
    AND current_setting('app.operation',true)='asset.upload-completion.observe'
    AND site_ref=current_setting('app.site_id',true)
  );
CREATE POLICY asset_upload_intent_worker_completion_update_lock_function
  ON platform.asset_upload_intent FOR UPDATE TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('asset-worker')
    AND current_setting('app.workload_kind',true)='platform_asset_worker'
    AND current_setting('app.operation',true)='asset.upload-completion.observe'
    AND site_ref=current_setting('app.site_id',true)
  );

CREATE POLICY asset_upload_intent_worker_promotion_lock_function
  ON platform.asset_upload_intent FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('asset-worker')
    AND current_setting('app.workload_kind',true)='platform_asset_worker'
    AND current_setting('app.operation',true)='asset.promotion.finalize'
    AND site_ref=current_setting('app.site_id',true)
  );
CREATE POLICY asset_upload_intent_worker_promotion_update_lock_function
  ON platform.asset_upload_intent FOR UPDATE TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('asset-worker')
    AND current_setting('app.workload_kind',true)='platform_asset_worker'
    AND current_setting('app.operation',true)='asset.promotion.finalize'
    AND site_ref=current_setting('app.site_id',true)
  );

CREATE FUNCTION platform.lock_asset_worker_promotion_authority(
  p_site_ref TEXT,
  p_intent_ref TEXT,
  p_subject_ref TEXT,
  p_subject_generation BIGINT,
  p_project_ref TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT platform.split_worker_role_identity_is_current('asset-worker')
     OR current_setting('app.workload_kind',true)<>'platform_asset_worker'
     OR current_setting('app.operation',true)<>'asset.promotion.finalize'
     OR current_setting('app.site_id',true)<>p_site_ref THEN
    RAISE EXCEPTION 'ASSET_WORKER_AUTHORITY_FENCE_INVALID' USING ERRCODE='42501';
  END IF;
  PERFORM 1
  FROM platform.asset_upload_intent intent
  JOIN platform.authorization_product_binding binding
    ON binding.workload_identity_id=intent.workload_identity_id
   AND binding.site_ref=intent.site_ref
   AND binding.release_ref=intent.site_release_ref
   AND binding.binding_epoch=intent.binding_epoch
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=intent.subject_ref AND subject.site_ref=binding.site_ref
  JOIN platform.authorization_project project
    ON project.project_ref=intent.project_ref AND project.site_ref=binding.site_ref
  JOIN platform.authorization_project_membership membership
    ON membership.project_ref=project.project_ref AND membership.subject_ref=subject.subject_ref
  WHERE intent.site_ref=p_site_ref AND intent.intent_ref=p_intent_ref
    AND intent.subject_ref=p_subject_ref AND intent.subject_generation=p_subject_generation
    AND intent.project_ref=p_project_ref
    AND binding.environment=current_setting('app.environment',true)
    AND binding.region=current_setting('app.region',true)
    AND binding.state='active'
    AND subject.subject_generation=p_subject_generation AND subject.state='active'
    AND project.state='active' AND membership.state='active'
  FOR UPDATE OF intent,binding,subject,project,membership;
  RETURN FOUND;
END
$function$;
REVOKE ALL ON FUNCTION platform.lock_asset_worker_promotion_authority(
  TEXT,TEXT,TEXT,BIGINT,TEXT
) FROM PUBLIC;

CREATE POLICY site_project_binding_worker_lock_function
  ON platform.site_project_binding FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('site-worker')
    AND current_setting('app.workload_kind',true)='platform_site_worker'
    AND current_setting('app.operation',true)='site.runtime.consume'
  );
CREATE POLICY site_project_binding_worker_update_lock_function
  ON platform.site_project_binding FOR UPDATE TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('site-worker')
    AND current_setting('app.workload_kind',true)='platform_site_worker'
    AND current_setting('app.operation',true)='site.runtime.consume'
  );

CREATE FUNCTION platform.lock_site_worker_project_binding(
  p_site_ref TEXT,
  p_environment TEXT,
  p_region TEXT
)
RETURNS TABLE(
  binding_ref TEXT,
  binding_epoch BIGINT,
  provider_namespace TEXT,
  provider_project_ref TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT platform.split_worker_role_identity_is_current('site-worker')
     OR current_setting('app.workload_kind',true)<>'platform_site_worker'
     OR current_setting('app.operation',true)<>'site.runtime.consume' THEN
    RAISE EXCEPTION 'SITE_WORKER_AUTHORITY_FENCE_INVALID' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT project.binding_ref,project.binding_epoch,
    project.provider_namespace,project.provider_project_ref
  FROM platform.site_project_binding project
  WHERE project.site_ref=p_site_ref AND project.environment=p_environment
    AND project.region=p_region AND project.state='active'
  FOR UPDATE OF project;
END
$function$;
REVOKE ALL ON FUNCTION platform.lock_site_worker_project_binding(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE FUNCTION platform.lock_site_worker_runtime_project_binding(
  p_binding_ref TEXT,
  p_site_ref TEXT,
  p_binding_epoch BIGINT,
  p_environment TEXT,
  p_region TEXT
)
RETURNS TABLE(
  binding_epoch BIGINT,
  provider_namespace TEXT,
  provider_project_ref TEXT
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT platform.split_worker_role_identity_is_current('site-worker')
     OR current_setting('app.workload_kind',true)<>'platform_site_worker'
     OR current_setting('app.operation',true)<>'site.runtime.consume' THEN
    RAISE EXCEPTION 'SITE_WORKER_AUTHORITY_FENCE_INVALID' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT project.binding_epoch,project.provider_namespace,project.provider_project_ref
  FROM platform.site_project_binding project
  WHERE project.binding_ref=p_binding_ref AND project.site_ref=p_site_ref
    AND (p_binding_epoch IS NULL OR project.binding_epoch=p_binding_epoch)
    AND project.environment=p_environment AND project.region=p_region AND project.state='active'
  FOR UPDATE OF project;
END
$function$;
REVOKE ALL ON FUNCTION platform.lock_site_worker_runtime_project_binding(
  TEXT,TEXT,BIGINT,TEXT,TEXT
) FROM PUBLIC;

CREATE POLICY admin_operator_authority_worker_lock_function
  ON platform.admin_operator_authority FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('admin-worker')
    AND current_setting('app.workload_kind',true)='platform_admin_worker'
    AND current_setting('app.operation',true)='admin.authority.change'
    AND current_setting('app.admin_execution',true)='true'
  );
CREATE POLICY admin_operator_authority_worker_update_lock_function
  ON platform.admin_operator_authority FOR UPDATE TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('admin-worker')
    AND current_setting('app.workload_kind',true)='platform_admin_worker'
    AND current_setting('app.operation',true)='admin.authority.change'
    AND current_setting('app.admin_execution',true)='true'
  );
CREATE POLICY admin_operator_site_scope_worker_projection_function
  ON platform.admin_operator_site_scope FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('admin-worker')
    AND current_setting('app.workload_kind',true)='platform_admin_worker'
    AND current_setting('app.operation',true)='admin.authority.change'
    AND current_setting('app.admin_execution',true)='true'
  );
CREATE POLICY admin_operator_global_scope_worker_projection_function
  ON platform.admin_operator_global_scope_grant FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('admin-worker')
    AND current_setting('app.workload_kind',true)='platform_admin_worker'
    AND current_setting('app.operation',true)='admin.authority.change'
    AND current_setting('app.admin_execution',true)='true'
  );
CREATE POLICY admin_breakglass_worker_projection_function
  ON platform.admin_breakglass_grant FOR SELECT TO CURRENT_USER
  USING (
    platform.split_worker_role_identity_is_current('admin-worker')
    AND current_setting('app.workload_kind',true)='platform_admin_worker'
    AND current_setting('app.operation',true)='admin.authority.change'
    AND current_setting('app.admin_execution',true)='true'
  );

CREATE FUNCTION platform.lock_admin_worker_operator_authority(
  p_operator_ref TEXT,
  p_operator_generation BIGINT
)
RETURNS TABLE(
  operator_ref TEXT,
  operator_generation BIGINT,
  state TEXT,
  permissions TEXT[],
  site_scopes TEXT[],
  global_scopes TEXT[],
  environments TEXT[],
  regions TEXT[],
  authorization_epoch BIGINT,
  expires_at TIMESTAMPTZ,
  break_glass_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $function$
BEGIN
  IF NOT platform.split_worker_role_identity_is_current('admin-worker')
     OR current_setting('app.workload_kind',true)<>'platform_admin_worker'
     OR current_setting('app.operation',true)<>'admin.authority.change'
     OR current_setting('app.admin_execution',true)<>'true' THEN
    RAISE EXCEPTION 'ADMIN_WORKER_AUTHORITY_FENCE_INVALID' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
  SELECT authority.operator_ref,authority.operator_generation,authority.state,
    authority.permissions,
    ARRAY(
      SELECT DISTINCT site_scope.site_ref
      FROM platform.admin_operator_site_scope site_scope
      WHERE site_scope.operator_ref=authority.operator_ref
        AND site_scope.operator_generation=authority.operator_generation
        AND site_scope.environment=current_setting('app.environment',true)
        AND site_scope.region=current_setting('app.region',true)
        AND site_scope.state='active' AND site_scope.expires_at>now()
      ORDER BY site_scope.site_ref
    ),
    ARRAY(
      SELECT global_scope.grant_ref::TEXT
      FROM platform.admin_operator_global_scope_grant global_scope
      WHERE global_scope.operator_ref=authority.operator_ref
        AND global_scope.operator_generation=authority.operator_generation
        AND global_scope.environment=current_setting('app.environment',true)
        AND global_scope.region=current_setting('app.region',true)
        AND global_scope.state='active' AND global_scope.expires_at>now()
      ORDER BY global_scope.grant_ref::TEXT
    ),
    ARRAY(
      SELECT DISTINCT deployment.environment
      FROM (
        SELECT site_scope.environment
        FROM platform.admin_operator_site_scope site_scope
        WHERE site_scope.operator_ref=authority.operator_ref
          AND site_scope.operator_generation=authority.operator_generation
          AND site_scope.environment=current_setting('app.environment',true)
          AND site_scope.region=current_setting('app.region',true)
          AND site_scope.state='active' AND site_scope.expires_at>now()
        UNION
        SELECT global_scope.environment
        FROM platform.admin_operator_global_scope_grant global_scope
        WHERE global_scope.operator_ref=authority.operator_ref
          AND global_scope.operator_generation=authority.operator_generation
          AND global_scope.environment=current_setting('app.environment',true)
          AND global_scope.region=current_setting('app.region',true)
          AND global_scope.state='active' AND global_scope.expires_at>now()
      ) deployment
      ORDER BY deployment.environment
    ),
    ARRAY(
      SELECT DISTINCT deployment.region
      FROM (
        SELECT site_scope.region
        FROM platform.admin_operator_site_scope site_scope
        WHERE site_scope.operator_ref=authority.operator_ref
          AND site_scope.operator_generation=authority.operator_generation
          AND site_scope.environment=current_setting('app.environment',true)
          AND site_scope.region=current_setting('app.region',true)
          AND site_scope.state='active' AND site_scope.expires_at>now()
        UNION
        SELECT global_scope.region
        FROM platform.admin_operator_global_scope_grant global_scope
        WHERE global_scope.operator_ref=authority.operator_ref
          AND global_scope.operator_generation=authority.operator_generation
          AND global_scope.environment=current_setting('app.environment',true)
          AND global_scope.region=current_setting('app.region',true)
          AND global_scope.state='active' AND global_scope.expires_at>now()
      ) deployment
      ORDER BY deployment.region
    ),
    authority.authorization_epoch,authority.expires_at,
    (
      SELECT max(breakglass.expires_at)
      FROM platform.admin_breakglass_grant breakglass
      WHERE breakglass.operator_ref=authority.operator_ref
        AND breakglass.operator_generation=authority.operator_generation
        AND breakglass.environment=current_setting('app.environment',true)
        AND breakglass.region=current_setting('app.region',true)
        AND breakglass.state='active' AND breakglass.expires_at>now()
    )
  FROM platform.admin_operator_authority authority
  WHERE authority.operator_ref=p_operator_ref
    AND authority.operator_generation=p_operator_generation
  FOR UPDATE OF authority;
END
$function$;
REVOKE ALL ON FUNCTION platform.lock_admin_worker_operator_authority(TEXT,BIGINT) FROM PUBLIC;
