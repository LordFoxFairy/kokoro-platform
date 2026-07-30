SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.model_site_policy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_assignment_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_policy_pointer ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_model_catalog_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_model_catalog_surface ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.site_release_model_catalog_option ENABLE ROW LEVEL SECURITY;

CREATE POLICY model_site_policy_admin_exact_scope
  ON platform.model_site_policy_revision FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR site_id IN (SELECT jsonb_array_elements_text(
        COALESCE(NULLIF(current_setting('app.admin_site_refs',true),''),'[]')::jsonb
      ))
    )
  );

CREATE POLICY model_site_assignment_admin_exact_scope
  ON platform.model_site_assignment_revision FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR site_id IN (SELECT jsonb_array_elements_text(
        COALESCE(NULLIF(current_setting('app.admin_site_refs',true),''),'[]')::jsonb
      ))
    )
  );

CREATE POLICY model_site_policy_pointer_admin_exact_scope
  ON platform.model_site_policy_pointer FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR site_id IN (SELECT jsonb_array_elements_text(
        COALESCE(NULLIF(current_setting('app.admin_site_refs',true),''),'[]')::jsonb
      ))
    )
  );

CREATE POLICY site_release_model_catalog_admin_exact_scope
  ON platform.site_release_model_catalog_publication FOR SELECT
  USING (
    current_setting('app.workload_kind',true)='platform_admin'
    AND site_id=NULLIF(current_setting('app.site_id',true),'')
    AND (
      current_setting('app.admin_scope_kind',true)='global'
      OR site_id IN (SELECT jsonb_array_elements_text(
        COALESCE(NULLIF(current_setting('app.admin_site_refs',true),''),'[]')::jsonb
      ))
    )
  );

CREATE POLICY site_release_model_catalog_surface_admin_exact_scope
  ON platform.site_release_model_catalog_surface FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM platform.site_release_model_catalog_publication publication
    WHERE publication.publication_id=site_release_model_catalog_surface.publication_id
      AND publication.site_id=NULLIF(current_setting('app.site_id',true),'')
  ));

CREATE POLICY site_release_model_catalog_option_admin_exact_scope
  ON platform.site_release_model_catalog_option FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM platform.site_release_model_catalog_publication publication
    WHERE publication.publication_id=site_release_model_catalog_option.publication_id
      AND publication.site_id=NULLIF(current_setting('app.site_id',true),'')
  ));

REVOKE ALL ON platform.model_site_policy_revision,
  platform.model_site_assignment_revision,
  platform.model_site_policy_pointer,
  platform.site_release_model_catalog_publication,
  platform.site_release_model_catalog_surface,
  platform.site_release_model_catalog_option FROM PUBLIC;
