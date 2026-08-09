SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Admission reads one immutable SiteRelease option and only the execution
-- metadata needed to construct a GA runtime. Provider account and secret
-- references never cross this projection.
CREATE FUNCTION platform.resolve_admission_model_owner(
  p_site_id TEXT,
  p_site_release_ref TEXT,
  p_model_option_revision_ref TEXT
) RETURNS TABLE(
  result_site_id TEXT,
  result_site_release_ref TEXT,
  result_inventory_digest TEXT,
  result_option_revision_payload JSONB,
  result_runtime_candidates JSONB
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  resolved_publication_id UUID;
  resolved_inventory_import_id UUID;
  resolved_inventory_digest TEXT;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'admission.command'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'platform_admission'
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ADMISSION_MODEL_OWNER_CONTEXT_REQUIRED';
  END IF;

  SELECT publication.publication_id,
         publication.inventory_import_id,
         publication.inventory_digest::TEXT
    INTO resolved_publication_id,resolved_inventory_import_id,resolved_inventory_digest
    FROM platform.site_release_model_catalog_publication publication
    JOIN platform.site site
      ON site.site_ref=publication.site_id
     AND site.state='active'
     AND site.active_release_ref=publication.site_release_ref
     AND site.tombstoned_at IS NULL
    JOIN platform.site_release release
      ON release.release_ref=publication.site_release_ref
     AND release.site_ref=publication.site_id
     AND release.state='active'
     AND release.model_option_catalog_ref=publication.model_option_catalog_ref
   WHERE publication.site_id=p_site_id
     AND publication.site_release_ref=p_site_release_ref;
  IF NOT FOUND THEN RETURN; END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM platform.site_release_model_catalog_option published
      JOIN platform.model_option_revision revision
        ON revision.revision_ref=published.revision_ref
       AND revision.inventory_import_id=resolved_inventory_import_id
       AND revision.inventory_digest=resolved_inventory_digest
     WHERE published.publication_id=resolved_publication_id
       AND published.revision_ref=p_model_option_revision_ref
  ) THEN RETURN; END IF;
  IF (SELECT count(*) FROM platform.model_provider_snapshot provider
      WHERE provider.import_id=resolved_inventory_import_id AND provider.adapter_kind='direct')<>1
     OR NOT EXISTS(
       SELECT 1 FROM platform.model_provider_snapshot provider
       WHERE provider.import_id=resolved_inventory_import_id
         AND provider.adapter_kind='direct'
         AND provider.provider_key='direct'
         AND provider.account_key='primary'
         AND provider.provider='openai-compatible'
         AND provider.secret_ref='secret://platform/model-gateway/direct'
     ) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='ADMISSION_MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH';
  END IF;

  RETURN QUERY SELECT
    p_site_id,
    p_site_release_ref,
    resolved_inventory_digest,
    platform.model_option_revision_payload(p_model_option_revision_ref),
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'modelKey',binding.model_key,
        'modelPosition',binding.position,
        'bindingKey',provider_binding.binding_key,
        'bindingPriority',provider_binding.priority,
        'providerPriority',provider.priority,
        'adapterKind',provider.adapter_kind,
        'providerKey',provider.provider_key,
        'provider',provider.provider,
        'upstreamModel',provider_binding.upstream_model,
        'gatewayModelName',provider_binding.gateway_model_name
      ) ORDER BY binding.position,provider_binding.priority,provider.priority,
                 provider_binding.binding_key COLLATE "C")
        FROM platform.model_option_role_binding binding
        JOIN platform.model_definition_snapshot model
          ON model.import_id=resolved_inventory_import_id
         AND model.model_key=binding.model_key
         AND model.enabled
        JOIN platform.model_definition_availability model_availability
          ON model_availability.model_key=model.model_key
         AND model_availability.status='active'
        JOIN platform.model_provider_binding_snapshot provider_binding
          ON provider_binding.import_id=resolved_inventory_import_id
         AND provider_binding.model_key=model.model_key
         AND provider_binding.enabled
        JOIN platform.model_provider_snapshot provider
          ON provider.import_id=provider_binding.import_id
         AND provider.provider_key=provider_binding.provider_key
        JOIN platform.model_provider_availability provider_availability
          ON provider_availability.provider_key=provider.provider_key
         AND provider_availability.status='active'
         AND (provider_availability.health IN ('healthy','degraded') OR (provider.adapter_kind='direct' AND provider_availability.health='unknown'))
       WHERE binding.revision_ref=p_model_option_revision_ref
         AND binding.inventory_import_id=resolved_inventory_import_id
         AND binding.composition_slot='orchestration'
    ),'[]'::JSONB);
END $$;

REVOKE ALL ON FUNCTION platform.resolve_admission_model_owner(TEXT,TEXT,TEXT) FROM PUBLIC;
