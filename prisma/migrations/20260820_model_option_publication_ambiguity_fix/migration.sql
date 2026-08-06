SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE OR REPLACE FUNCTION platform.publish_site_release_model_catalog(
  p_publication_id UUID,p_catalog JSONB,p_published_by TEXT
) RETURNS TABLE(
  result_publication_id UUID,result_site_id TEXT,result_site_release_ref TEXT,
  result_model_option_catalog_ref TEXT,result_catalog_digest TEXT,
  result_published_at TIMESTAMPTZ,replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  existing platform.site_release_model_catalog_publication%ROWTYPE;
  release_authority platform.authorization_site_release%ROWTYPE;
  inventory_id UUID;
  surface_payload JSONB;
  option_revision_ref TEXT;
  surface_position INTEGER:=0;
  option_position INTEGER;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.site-release-catalog.publish'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR COALESCE(current_setting('app.actor_kind',true),'') NOT IN ('operator','workload')
     OR p_published_by IS DISTINCT FROM current_setting('app.subject_id',true)
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_catalog->>'siteId'
     OR NOT COALESCE(current_setting('app.scopes',true)::JSONB ? 'model:site-release:publish',FALSE) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='MODEL_OPTION_PUBLICATION_CONTEXT_REQUIRED';
  END IF;
  IF jsonb_typeof(p_catalog) IS DISTINCT FROM 'object'
     OR NOT (p_catalog ?& ARRAY['schemaVersion','modelOptionCatalogRef','catalogDigest','siteId',
       'siteReleaseRef','inventoryDigest','publishedAt','surfaces'])
     OR p_catalog-ARRAY['schemaVersion','modelOptionCatalogRef','catalogDigest','siteId',
       'siteReleaseRef','inventoryDigest','publishedAt','surfaces']::TEXT[]<>'{}'::JSONB
     OR jsonb_typeof(p_catalog->'surfaces') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_PUBLICATION_INVALID';
  END IF;
  SELECT release.* INTO release_authority FROM platform.authorization_site_release release
    WHERE release.release_ref=p_catalog->>'siteReleaseRef' AND release.site_ref=p_catalog->>'siteId'
    FOR UPDATE;
  IF NOT FOUND OR release_authority.state<>'active'
     OR release_authority.model_option_catalog_ref<>p_catalog->>'modelOptionCatalogRef' THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='MODEL_OPTION_RELEASE_AUTHORITY_MISMATCH';
  END IF;
  SELECT import_id INTO inventory_id FROM platform.model_inventory_import
    WHERE source_digest=p_catalog->>'inventoryDigest';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='MODEL_OPTION_INVENTORY_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'kokoro-platform:model-option-publication:'||(p_catalog->>'siteId')||':'||(p_catalog->>'siteReleaseRef'),0));
  SELECT publication.* INTO existing FROM platform.site_release_model_catalog_publication publication
    WHERE publication.publication_id=p_publication_id;
  IF FOUND THEN
    IF (platform.site_release_model_catalog_payload(existing.publication_id) - 'publishedAt')
         IS DISTINCT FROM (p_catalog - 'publishedAt')
       OR existing.published_by<>p_published_by THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='MODEL_OPTION_PUBLICATION_ID_CONFLICT';
    END IF;
    RETURN QUERY SELECT existing.publication_id,existing.site_id,existing.site_release_ref,
      existing.model_option_catalog_ref,existing.catalog_digest::TEXT,existing.published_at,TRUE;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM platform.site_release_model_catalog_publication publication
    WHERE publication.site_id=p_catalog->>'siteId' AND publication.site_release_ref=p_catalog->>'siteReleaseRef') THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='MODEL_OPTION_RELEASE_ALREADY_PUBLISHED';
  END IF;
  INSERT INTO platform.site_release_model_catalog_publication(
    publication_id,model_option_catalog_ref,catalog_digest,site_id,site_release_ref,
    inventory_import_id,inventory_digest,schema_version,published_by,published_at
  ) VALUES(
    p_publication_id,p_catalog->>'modelOptionCatalogRef',p_catalog->>'catalogDigest',
    p_catalog->>'siteId',p_catalog->>'siteReleaseRef',inventory_id,p_catalog->>'inventoryDigest',
    (p_catalog->>'schemaVersion')::INTEGER,p_published_by,(p_catalog->>'publishedAt')::TIMESTAMPTZ
  );
  FOR surface_payload IN
    SELECT surface_element.value
    FROM jsonb_array_elements(p_catalog->'surfaces') AS surface_element(value)
  LOOP
    IF jsonb_typeof(surface_payload) IS DISTINCT FROM 'object'
       OR NOT (surface_payload ?& ARRAY['surfaceId','catalogRevisionRef','catalogDigest',
         'defaultModelOptionRevisionRef','allowedModelOptionRevisionRefs'])
       OR jsonb_typeof(surface_payload->'allowedModelOptionRevisionRefs') IS DISTINCT FROM 'array'
       OR NOT surface_payload->'allowedModelOptionRevisionRefs' ? (surface_payload->>'defaultModelOptionRevisionRef') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_SURFACE_PUBLICATION_INVALID';
    END IF;
    INSERT INTO platform.site_release_model_catalog_surface(
      publication_id,surface_id,position,catalog_revision_ref,catalog_digest,
      default_model_option_revision_ref
    ) VALUES(
      p_publication_id,surface_payload->>'surfaceId',surface_position,
      surface_payload->>'catalogRevisionRef',surface_payload->>'catalogDigest',
      surface_payload->>'defaultModelOptionRevisionRef'
    );
    option_position:=0;
    FOR option_revision_ref IN
      SELECT option_element.value
      FROM jsonb_array_elements_text(surface_payload->'allowedModelOptionRevisionRefs')
        AS option_element(value)
    LOOP
      IF NOT EXISTS(SELECT 1 FROM platform.model_option_revision revision
        WHERE revision.revision_ref=option_revision_ref
          AND revision.inventory_import_id=inventory_id
          AND revision.inventory_digest=p_catalog->>'inventoryDigest'
          AND revision.surface=surface_payload->>'surfaceId') THEN
        RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='MODEL_OPTION_PUBLICATION_REVISION_MISMATCH';
      END IF;
      INSERT INTO platform.site_release_model_catalog_option(
        publication_id,surface_id,position,revision_ref,is_default
      ) VALUES(
        p_publication_id,surface_payload->>'surfaceId',option_position,option_revision_ref,
        option_revision_ref=surface_payload->>'defaultModelOptionRevisionRef'
      );
      option_position:=option_position+1;
    END LOOP;
    surface_position:=surface_position+1;
  END LOOP;
  IF surface_position<1 OR platform.site_release_model_catalog_payload(p_publication_id) IS DISTINCT FROM p_catalog THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='MODEL_OPTION_PUBLICATION_PAYLOAD_MISMATCH';
  END IF;
  RETURN QUERY SELECT p_publication_id,p_catalog->>'siteId',p_catalog->>'siteReleaseRef',
    p_catalog->>'modelOptionCatalogRef',p_catalog->>'catalogDigest',
    (p_catalog->>'publishedAt')::TIMESTAMPTZ,FALSE;
END $$;
