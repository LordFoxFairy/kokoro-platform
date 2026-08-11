SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- A transaction-local custom GUC becomes an empty string after commit. Keep the
-- existing evidence policies fail-closed when a pooled connection later has no
-- binding epoch instead of trying to cast that empty value to BIGINT.
DROP POLICY site_project_binding_evidence_admission_read
  ON platform.site_project_binding;
CREATE POLICY site_project_binding_evidence_admission_read
  ON platform.site_project_binding FOR SELECT
  USING (
    platform.site_evidence_resolver_role_is_current() AND
    current_setting('app.workload_kind',true)='platform_admission' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.authorize' AND
    binding_ref=current_setting('app.site_project_binding_ref',true) AND
    binding_epoch=NULLIF(current_setting('app.workload_binding_epoch',true),'')::BIGINT AND
    workload_identity_id=current_setting('app.workload_identity_ref',true) AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    region=current_setting('app.region',true) AND state='active'
  );

DROP POLICY site_evidence_owner_live_binding
  ON platform.site_project_binding;
CREATE POLICY site_evidence_owner_live_binding
  ON platform.site_project_binding FOR SELECT
  USING (
    platform.site_evidence_owner_role_is_current() AND
    current_setting('app.workload_kind',true)='platform_worker' AND
    current_setting('app.actor_kind',true)='workload' AND
    current_setting('app.operation',true)='site.evidence.record' AND
    binding_epoch=NULLIF(current_setting('app.workload_binding_epoch',true),'')::BIGINT AND
    workload_identity_id=current_setting('app.workload_identity_ref',true) AND
    site_ref=NULLIF(current_setting('app.site_id',true),'') AND
    environment=current_setting('app.environment',true) AND
    region=current_setting('app.region',true) AND state='active'
  );

CREATE FUNCTION platform.core_single_site_bootstrap_identity_ready(
  p_site_ref TEXT,
  p_account_ref UUID,
  p_subject_ref TEXT,
  p_workspace_ref TEXT,
  p_project_ref TEXT,
  p_billing_account_ref TEXT,
  p_execution_space_ref TEXT,
  p_execution_namespace TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$
BEGIN
  IF current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR current_setting('app.operation',true) NOT IN (
       'core.single-site.bootstrap','core.single-site.bootstrap.recover'
     )
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'operator'
     OR NULLIF(current_setting('app.subject_id',true),'') IS NULL
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_site_ref
     OR current_setting('app.purpose',true) IS DISTINCT FROM
       current_setting('app.operation',true)
     OR current_setting('app.scopes',true)::JSONB IS DISTINCT FROM
       (CASE current_setting('app.operation',true)
         WHEN 'core.single-site.bootstrap' THEN '["core.single-site.bootstrap"]'::JSONB
         ELSE '["core.single-site.bootstrap:recover"]'::JSONB
       END) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='CORE_SINGLE_SITE_BOOTSTRAP_IDENTITY_READ_CONTEXT_REQUIRED';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM platform.identity_account account
    WHERE account.site_ref=p_site_ref
      AND account.account_ref=p_account_ref::TEXT
      AND account.subject_ref=p_subject_ref
      AND account.state='active'
  ) AND EXISTS (
    SELECT 1
    FROM platform.identity_personal_bootstrap personal
    JOIN platform.identity_account account
      ON account.site_ref=personal.site_ref
     AND account.subject_ref=personal.subject_ref
    JOIN platform.authorization_subject subject_authority
      ON subject_authority.site_ref=personal.site_ref
     AND subject_authority.subject_ref=personal.subject_ref
     AND subject_authority.subject_generation=personal.subject_generation
    JOIN platform.identity_execution_space execution
      ON execution.site_ref=personal.site_ref
     AND execution.execution_space_ref=personal.execution_space_ref
     AND execution.execution_namespace=personal.execution_namespace
     AND execution.project_ref=personal.project_ref
    JOIN platform.identity_namespace_allocation_intent intent
      ON intent.intent_ref=personal.namespace_intent_ref
     AND intent.site_ref=personal.site_ref
     AND intent.execution_space_ref=personal.execution_space_ref
     AND intent.execution_namespace=personal.execution_namespace
    WHERE personal.site_ref=p_site_ref
      AND personal.subject_ref=p_subject_ref
      AND personal.workspace_ref=p_workspace_ref
      AND personal.project_ref=p_project_ref
      AND personal.billing_account_ref=p_billing_account_ref
      AND personal.execution_space_ref=p_execution_space_ref
      AND personal.execution_namespace=p_execution_namespace
      AND account.account_ref=p_account_ref::TEXT
      AND account.state='active'
      AND subject_authority.state='active'
      AND execution.state='active'
      AND intent.state='applied'
  );
END;
$$;

CREATE FUNCTION platform.core_single_site_bootstrap_model_catalog_ready(
  p_site_ref TEXT,
  p_site_release_ref TEXT,
  p_model_option_catalog_ref TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, platform
AS $$
BEGIN
  IF current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR current_setting('app.operation',true) NOT IN (
       'core.single-site.bootstrap','core.single-site.bootstrap.recover'
     )
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'operator'
     OR NULLIF(current_setting('app.subject_id',true),'') IS NULL
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_site_ref
     OR current_setting('app.purpose',true) IS DISTINCT FROM
       current_setting('app.operation',true)
     OR current_setting('app.scopes',true)::JSONB IS DISTINCT FROM
       (CASE current_setting('app.operation',true)
         WHEN 'core.single-site.bootstrap' THEN '["core.single-site.bootstrap"]'::JSONB
         ELSE '["core.single-site.bootstrap:recover"]'::JSONB
       END) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='CORE_SINGLE_SITE_BOOTSTRAP_MODEL_CATALOG_READ_CONTEXT_REQUIRED';
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM platform.site_release_model_catalog_publication catalog
    WHERE catalog.site_id=p_site_ref
      AND catalog.site_release_ref=p_site_release_ref
      AND catalog.model_option_catalog_ref=p_model_option_catalog_ref
  );
END;
$$;

REVOKE ALL ON FUNCTION platform.core_single_site_bootstrap_identity_ready(
  TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.core_single_site_bootstrap_model_catalog_ready(
  TEXT,TEXT,TEXT
) FROM PUBLIC;
