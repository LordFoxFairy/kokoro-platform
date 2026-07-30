SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.model_option_materialization (
  materialization_id UUID PRIMARY KEY,
  source_digest CHAR(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  inventory_import_id UUID NOT NULL,
  inventory_digest CHAR(64) NOT NULL CHECK (inventory_digest ~ '^[a-f0-9]{64}$'),
  materialization_digest CHAR(64) NOT NULL UNIQUE CHECK (materialization_digest ~ '^[a-f0-9]{64}$'),
  compiler_version TEXT NOT NULL CHECK (compiler_version='model-option-compiler.v2'),
  option_revision_count INTEGER NOT NULL CHECK (option_revision_count BETWEEN 1 AND 256),
  materialized_by TEXT NOT NULL,
  materialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(materialization_id,source_digest,inventory_digest,materialization_digest),
  FOREIGN KEY(inventory_import_id,inventory_digest)
    REFERENCES platform.model_inventory_import(import_id,source_digest)
);

CREATE TABLE platform.model_option_revision (
  revision_ref TEXT PRIMARY KEY CHECK (revision_ref ~ '^model-option:sha256:[a-f0-9]{64}$'),
  revision_digest CHAR(64) NOT NULL UNIQUE CHECK (revision_digest ~ '^[a-f0-9]{64}$'),
  inventory_import_id UUID NOT NULL,
  inventory_digest CHAR(64) NOT NULL CHECK (inventory_digest ~ '^[a-f0-9]{64}$'),
  schema_version INTEGER NOT NULL CHECK (schema_version=1),
  option_key TEXT NOT NULL CHECK (option_key ~ '^[a-z][a-z0-9._-]{1,127}$'),
  surface TEXT NOT NULL CHECK (surface IN ('chat','music','image','video')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 128 AND label !~ '[[:cntrl:]]'),
  description TEXT CHECK (description IS NULL OR (char_length(description)<=512 AND description !~ '[[:cntrl:]]')),
  tier TEXT CHECK (tier IS NULL OR tier ~ '^[a-z][a-z0-9._-]{0,63}$'),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','disabled')),
  input_modalities TEXT[] NOT NULL CHECK (cardinality(input_modalities) BETWEEN 1 AND 16),
  output_modalities TEXT[] NOT NULL CHECK (cardinality(output_modalities) BETWEEN 1 AND 16),
  supported_efforts TEXT[] NOT NULL CHECK (cardinality(supported_efforts) BETWEEN 0 AND 16),
  badges TEXT[] NOT NULL CHECK (cardinality(badges) BETWEEN 0 AND 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(inventory_import_id,inventory_digest)
    REFERENCES platform.model_inventory_import(import_id,source_digest),
  CHECK (revision_ref='model-option:sha256:'||revision_digest)
);
CREATE INDEX model_option_revision_inventory_surface_idx
  ON platform.model_option_revision(inventory_digest,surface,option_key);

CREATE TABLE platform.model_option_materialized_revision (
  materialization_id UUID NOT NULL REFERENCES platform.model_option_materialization(materialization_id),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 100000),
  revision_ref TEXT NOT NULL REFERENCES platform.model_option_revision(revision_ref),
  PRIMARY KEY(materialization_id,position),
  UNIQUE(materialization_id,revision_ref)
);

CREATE TABLE platform.model_option_role_binding (
  revision_ref TEXT NOT NULL REFERENCES platform.model_option_revision(revision_ref),
  composition_slot TEXT NOT NULL CHECK (composition_slot IN ('orchestration','generation')),
  role_key TEXT NOT NULL CHECK (role_key IN (
    'assistant.primary','music.assistant','music.generation','image.assistant',
    'image.generation','video.assistant','video.generation'
  )),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 256),
  binding_kind TEXT NOT NULL CHECK (
    (position=0 AND binding_kind='primary') OR (position>0 AND binding_kind='fallback')
  ),
  inventory_import_id UUID NOT NULL,
  model_key TEXT NOT NULL,
  required_capabilities TEXT[] NOT NULL CHECK (cardinality(required_capabilities) BETWEEN 1 AND 16),
  fallback_policy TEXT NOT NULL CHECK (fallback_policy='ordered_pre_effect_only'),
  PRIMARY KEY(revision_ref,composition_slot,position),
  UNIQUE(revision_ref,composition_slot,model_key),
  FOREIGN KEY(inventory_import_id,model_key)
    REFERENCES platform.model_definition_snapshot(import_id,model_key)
);

ALTER TABLE platform.authorization_site_release
  ADD CONSTRAINT authorization_site_release_catalog_authority_key
  UNIQUE(release_ref,site_ref,model_option_catalog_ref);

CREATE TABLE platform.site_release_model_catalog_publication (
  publication_id UUID PRIMARY KEY,
  model_option_catalog_ref TEXT NOT NULL UNIQUE
    CHECK (model_option_catalog_ref ~ '^site-release-model-catalog:sha256:[a-f0-9]{64}$'),
  catalog_digest CHAR(64) NOT NULL UNIQUE CHECK (catalog_digest ~ '^[a-f0-9]{64}$'),
  site_id TEXT NOT NULL,
  site_release_ref TEXT NOT NULL,
  inventory_import_id UUID NOT NULL,
  inventory_digest CHAR(64) NOT NULL CHECK (inventory_digest ~ '^[a-f0-9]{64}$'),
  schema_version INTEGER NOT NULL CHECK (schema_version=1),
  published_by TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  UNIQUE(site_id,site_release_ref),
  UNIQUE(site_release_ref,site_id,model_option_catalog_ref),
  CHECK (model_option_catalog_ref='site-release-model-catalog:sha256:'||catalog_digest),
  FOREIGN KEY(inventory_import_id,inventory_digest)
    REFERENCES platform.model_inventory_import(import_id,source_digest),
  FOREIGN KEY(site_release_ref,site_id,model_option_catalog_ref)
    REFERENCES platform.authorization_site_release(release_ref,site_ref,model_option_catalog_ref)
);

CREATE TABLE platform.site_release_model_catalog_surface (
  publication_id UUID NOT NULL REFERENCES platform.site_release_model_catalog_publication(publication_id),
  surface_id TEXT NOT NULL CHECK (surface_id IN ('chat','music','image','video')),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  catalog_revision_ref TEXT NOT NULL,
  catalog_digest CHAR(64) NOT NULL CHECK (catalog_digest ~ '^[a-f0-9]{64}$'),
  default_model_option_revision_ref TEXT NOT NULL REFERENCES platform.model_option_revision(revision_ref),
  PRIMARY KEY(publication_id,surface_id),
  UNIQUE(publication_id,position),
  UNIQUE(publication_id,catalog_revision_ref),
  CHECK (catalog_revision_ref='surface-model-catalog:'||surface_id||':sha256:'||catalog_digest)
);

CREATE TABLE platform.site_release_model_catalog_option (
  publication_id UUID NOT NULL,
  surface_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 255),
  revision_ref TEXT NOT NULL REFERENCES platform.model_option_revision(revision_ref),
  is_default BOOLEAN NOT NULL,
  PRIMARY KEY(publication_id,surface_id,position),
  UNIQUE(publication_id,surface_id,revision_ref),
  FOREIGN KEY(publication_id,surface_id)
    REFERENCES platform.site_release_model_catalog_surface(publication_id,surface_id)
);
CREATE UNIQUE INDEX site_release_model_catalog_one_default_idx
  ON platform.site_release_model_catalog_option(publication_id,surface_id) WHERE is_default;

CREATE TRIGGER model_option_materialization_immutable
  BEFORE UPDATE OR DELETE ON platform.model_option_materialization
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER model_option_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.model_option_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER model_option_materialized_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.model_option_materialized_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER model_option_role_binding_immutable
  BEFORE UPDATE OR DELETE ON platform.model_option_role_binding
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER site_release_model_catalog_publication_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_model_catalog_publication
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER site_release_model_catalog_surface_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_model_catalog_surface
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();
CREATE TRIGGER site_release_model_catalog_option_immutable
  BEFORE UPDATE OR DELETE ON platform.site_release_model_catalog_option
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update();

CREATE FUNCTION platform.model_option_revision_payload(p_revision_ref TEXT) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
  SELECT jsonb_build_object(
    'schemaVersion',revision.schema_version,
    'modelOptionRevisionRef',revision.revision_ref,
    'revisionDigest',revision.revision_digest::TEXT,
    'inventoryDigest',revision.inventory_digest::TEXT,
    'optionKey',revision.option_key,
    'surface',revision.surface,
    'label',revision.label,
    'description',revision.description,
    'tier',revision.tier,
    'lifecycle',revision.lifecycle,
    'inputModalities',to_jsonb(revision.input_modalities),
    'outputModalities',to_jsonb(revision.output_modalities),
    'supportedEfforts',to_jsonb(revision.supported_efforts),
    'badges',to_jsonb(revision.badges),
    'composition',jsonb_build_object(
      'orchestration',jsonb_build_object(
        'roleKey',(SELECT role_key FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='orchestration' AND position=0),
        'primaryModelKey',(SELECT model_key FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='orchestration' AND position=0),
        'fallbackModelKeys',COALESCE((SELECT jsonb_agg(model_key ORDER BY position)
          FROM platform.model_option_role_binding binding WHERE binding.revision_ref=revision.revision_ref
          AND composition_slot='orchestration' AND position>0),'[]'::JSONB),
        'requiredCapabilities',to_jsonb((SELECT required_capabilities
          FROM platform.model_option_role_binding binding WHERE binding.revision_ref=revision.revision_ref
          AND composition_slot='orchestration' AND position=0)),
        'fallbackPolicy',(SELECT fallback_policy FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='orchestration' AND position=0)
      ),
      'generation',jsonb_build_object(
        'roleKey',(SELECT role_key FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='generation' AND position=0),
        'primaryModelKey',(SELECT model_key FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='generation' AND position=0),
        'fallbackModelKeys',COALESCE((SELECT jsonb_agg(model_key ORDER BY position)
          FROM platform.model_option_role_binding binding WHERE binding.revision_ref=revision.revision_ref
          AND composition_slot='generation' AND position>0),'[]'::JSONB),
        'requiredCapabilities',to_jsonb((SELECT required_capabilities
          FROM platform.model_option_role_binding binding WHERE binding.revision_ref=revision.revision_ref
          AND composition_slot='generation' AND position=0)),
        'fallbackPolicy',(SELECT fallback_policy FROM platform.model_option_role_binding binding
          WHERE binding.revision_ref=revision.revision_ref AND composition_slot='generation' AND position=0)
      )
    )
  ) FROM platform.model_option_revision revision WHERE revision.revision_ref=p_revision_ref
$$;

CREATE FUNCTION platform.load_model_option_inventory(p_inventory_digest TEXT)
RETURNS TABLE(result_canonical_payload JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.option.materialize'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR COALESCE(current_setting('app.actor_kind',true),'') NOT IN ('operator','workload') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='MODEL_OPTION_INVENTORY_CONTEXT_REQUIRED';
  END IF;
  RETURN QUERY SELECT canonical_payload FROM platform.model_inventory_import
    WHERE source_digest=p_inventory_digest;
END $$;

CREATE FUNCTION platform.load_model_option_revisions(p_revision_refs TEXT[])
RETURNS TABLE(result_revision_payload JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.site-release-catalog.publish'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR COALESCE(current_setting('app.actor_kind',true),'') NOT IN ('operator','workload') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='MODEL_OPTION_REVISION_CONTEXT_REQUIRED';
  END IF;
  IF p_revision_refs IS NULL OR cardinality(p_revision_refs)<1
     OR cardinality(p_revision_refs)<>cardinality(ARRAY(SELECT DISTINCT value FROM unnest(p_revision_refs) value)) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_REVISION_REFS_INVALID';
  END IF;
  RETURN QUERY SELECT platform.model_option_revision_payload(requested.revision_ref)
    FROM unnest(p_revision_refs) WITH ORDINALITY requested(revision_ref,position)
    JOIN platform.model_option_revision revision ON revision.revision_ref=requested.revision_ref
    ORDER BY requested.position;
END $$;

CREATE FUNCTION platform.materialize_model_options(
  p_materialization_id UUID,p_source_digest TEXT,p_inventory_digest TEXT,
  p_materialization_digest TEXT,p_compiler_version TEXT,p_option_revisions JSONB,
  p_materialized_by TEXT
) RETURNS TABLE(
  result_materialization_id UUID,result_source_digest TEXT,result_inventory_digest TEXT,
  result_materialization_digest TEXT,result_option_revision_refs TEXT[],replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE
  existing platform.model_option_materialization%ROWTYPE;
  inventory_id UUID;
  option_payload JSONB;
  role_payload JSONB;
  role_slot TEXT;
  option_ref TEXT;
  option_position INTEGER:=0;
  candidate_model TEXT;
  candidate_position INTEGER;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.option.materialize'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR COALESCE(current_setting('app.actor_kind',true),'') NOT IN ('operator','workload')
     OR p_materialized_by IS DISTINCT FROM current_setting('app.subject_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='MODEL_OPTION_MATERIALIZATION_CONTEXT_REQUIRED';
  END IF;
  IF p_source_digest !~ '^[a-f0-9]{64}$' OR p_inventory_digest !~ '^[a-f0-9]{64}$'
     OR p_materialization_digest !~ '^[a-f0-9]{64}$' OR p_compiler_version<>'model-option-compiler.v2'
     OR jsonb_typeof(p_option_revisions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_option_revisions) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_MATERIALIZATION_INVALID';
  END IF;
  SELECT import_id INTO inventory_id FROM platform.model_inventory_import
    WHERE source_digest=p_inventory_digest;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='MODEL_OPTION_INVENTORY_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kokoro-platform:model-option-materialization:'||p_materialization_id::TEXT,0));
  SELECT materialization.* INTO existing FROM platform.model_option_materialization materialization
    WHERE materialization.materialization_id=p_materialization_id;
  IF FOUND THEN
    IF existing.source_digest<>p_source_digest OR existing.inventory_digest<>p_inventory_digest
       OR existing.materialization_digest<>p_materialization_digest OR existing.compiler_version<>p_compiler_version
       OR existing.option_revision_count<>jsonb_array_length(p_option_revisions) THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='MODEL_OPTION_MATERIALIZATION_ID_CONFLICT';
    END IF;
    RETURN QUERY SELECT existing.materialization_id,existing.source_digest::TEXT,
      existing.inventory_digest::TEXT,existing.materialization_digest::TEXT,
      ARRAY(SELECT link.revision_ref FROM platform.model_option_materialized_revision link
        WHERE link.materialization_id=existing.materialization_id ORDER BY link.position),TRUE;
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM platform.model_option_materialization
    WHERE materialization_digest=p_materialization_digest) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='MODEL_OPTION_MATERIALIZATION_DIGEST_CONFLICT';
  END IF;
  INSERT INTO platform.model_option_materialization(
    materialization_id,source_digest,inventory_import_id,inventory_digest,
    materialization_digest,compiler_version,option_revision_count,materialized_by
  ) VALUES(
    p_materialization_id,p_source_digest,inventory_id,p_inventory_digest,
    p_materialization_digest,p_compiler_version,jsonb_array_length(p_option_revisions),p_materialized_by
  );
  FOR option_payload IN SELECT value FROM jsonb_array_elements(p_option_revisions) LOOP
    IF jsonb_typeof(option_payload) IS DISTINCT FROM 'object'
       OR NOT (option_payload ?& ARRAY['schemaVersion','modelOptionRevisionRef','revisionDigest',
         'inventoryDigest','optionKey','surface','label','description','tier','lifecycle',
         'inputModalities','outputModalities','supportedEfforts','badges','composition'])
       OR option_payload-ARRAY['schemaVersion','modelOptionRevisionRef','revisionDigest',
         'inventoryDigest','optionKey','surface','label','description','tier','lifecycle',
         'inputModalities','outputModalities','supportedEfforts','badges','composition']::TEXT[]<>'{}'::JSONB
       OR option_payload->>'inventoryDigest'<>p_inventory_digest THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_REVISION_INVALID';
    END IF;
    option_ref:=option_payload->>'modelOptionRevisionRef';
    INSERT INTO platform.model_option_revision(
      revision_ref,revision_digest,inventory_import_id,inventory_digest,schema_version,
      option_key,surface,label,description,tier,lifecycle,input_modalities,output_modalities,
      supported_efforts,badges
    ) VALUES(
      option_ref,option_payload->>'revisionDigest',inventory_id,p_inventory_digest,
      (option_payload->>'schemaVersion')::INTEGER,option_payload->>'optionKey',option_payload->>'surface',
      option_payload->>'label',option_payload->>'description',option_payload->>'tier',
      option_payload->>'lifecycle',ARRAY(SELECT jsonb_array_elements_text(option_payload->'inputModalities')),
      ARRAY(SELECT jsonb_array_elements_text(option_payload->'outputModalities')),
      ARRAY(SELECT jsonb_array_elements_text(option_payload->'supportedEfforts')),
      ARRAY(SELECT jsonb_array_elements_text(option_payload->'badges'))
    ) ON CONFLICT(revision_ref) DO NOTHING;
    FOREACH role_slot IN ARRAY ARRAY['orchestration','generation'] LOOP
      role_payload:=option_payload#>ARRAY['composition',role_slot];
      IF jsonb_typeof(role_payload) IS DISTINCT FROM 'object'
         OR NOT (role_payload ?& ARRAY['roleKey','primaryModelKey','fallbackModelKeys','requiredCapabilities','fallbackPolicy'])
         OR role_payload-ARRAY['roleKey','primaryModelKey','fallbackModelKeys','requiredCapabilities','fallbackPolicy']::TEXT[]<>'{}'::JSONB THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='MODEL_OPTION_ROLE_BINDING_INVALID';
      END IF;
      candidate_position:=0;
      FOR candidate_model IN
        SELECT role_payload->>'primaryModelKey'
        UNION ALL
        SELECT value FROM jsonb_array_elements_text(role_payload->'fallbackModelKeys')
      LOOP
        INSERT INTO platform.model_option_role_binding(
          revision_ref,composition_slot,role_key,position,binding_kind,inventory_import_id,
          model_key,required_capabilities,fallback_policy
        ) VALUES(
          option_ref,role_slot,role_payload->>'roleKey',candidate_position,
          CASE WHEN candidate_position=0 THEN 'primary' ELSE 'fallback' END,inventory_id,candidate_model,
          ARRAY(SELECT jsonb_array_elements_text(role_payload->'requiredCapabilities')),
          role_payload->>'fallbackPolicy'
        ) ON CONFLICT(revision_ref,composition_slot,position) DO NOTHING;
        candidate_position:=candidate_position+1;
      END LOOP;
    END LOOP;
    IF platform.model_option_revision_payload(option_ref) IS DISTINCT FROM option_payload THEN
      RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='MODEL_OPTION_REVISION_CONFLICT';
    END IF;
    INSERT INTO platform.model_option_materialized_revision(materialization_id,position,revision_ref)
      VALUES(p_materialization_id,option_position,option_ref);
    option_position:=option_position+1;
  END LOOP;
  RETURN QUERY SELECT p_materialization_id,p_source_digest,p_inventory_digest,
    p_materialization_digest,ARRAY(SELECT link.revision_ref
      FROM platform.model_option_materialized_revision link
      WHERE link.materialization_id=p_materialization_id ORDER BY link.position),
    FALSE;
END $$;

CREATE FUNCTION platform.site_release_model_catalog_payload(p_publication_id UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
  SELECT jsonb_build_object(
    'schemaVersion',publication.schema_version,
    'modelOptionCatalogRef',publication.model_option_catalog_ref,
    'catalogDigest',publication.catalog_digest::TEXT,
    'siteId',publication.site_id,
    'siteReleaseRef',publication.site_release_ref,
    'inventoryDigest',publication.inventory_digest::TEXT,
    'publishedAt',to_char(publication.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'surfaces',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'surfaceId',surface.surface_id,
      'catalogRevisionRef',surface.catalog_revision_ref,
      'catalogDigest',surface.catalog_digest::TEXT,
      'defaultModelOptionRevisionRef',surface.default_model_option_revision_ref,
      'allowedModelOptionRevisionRefs',(SELECT jsonb_agg(option.revision_ref ORDER BY option.position)
        FROM platform.site_release_model_catalog_option option
        WHERE option.publication_id=surface.publication_id AND option.surface_id=surface.surface_id)
    ) ORDER BY surface.position) FROM platform.site_release_model_catalog_surface surface
      WHERE surface.publication_id=publication.publication_id),'[]'::JSONB)
  ) FROM platform.site_release_model_catalog_publication publication
    WHERE publication.publication_id=p_publication_id
$$;

CREATE FUNCTION platform.publish_site_release_model_catalog(
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
  revision_ref TEXT;
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
  FOR surface_payload IN SELECT value FROM jsonb_array_elements(p_catalog->'surfaces') LOOP
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
    FOR revision_ref IN SELECT value FROM jsonb_array_elements_text(surface_payload->'allowedModelOptionRevisionRefs') LOOP
      IF NOT EXISTS(SELECT 1 FROM platform.model_option_revision revision
        WHERE revision.revision_ref=revision_ref
          AND revision.inventory_import_id=inventory_id
          AND revision.inventory_digest=p_catalog->>'inventoryDigest'
          AND revision.surface=surface_payload->>'surfaceId') THEN
        RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='MODEL_OPTION_PUBLICATION_REVISION_MISMATCH';
      END IF;
      INSERT INTO platform.site_release_model_catalog_option(
        publication_id,surface_id,position,revision_ref,is_default
      ) VALUES(
        p_publication_id,surface_payload->>'surfaceId',option_position,revision_ref,
        revision_ref=surface_payload->>'defaultModelOptionRevisionRef'
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

CREATE FUNCTION platform.resolve_product_model_option_catalog(p_site_id TEXT,p_site_release_ref TEXT)
RETURNS TABLE(
  result_release_payload JSONB,result_option_revision_payloads JSONB,
  result_runtime_available_model_keys TEXT[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE resolved_publication_id UUID;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'exchangeProductContext'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'site_product'
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_site_id THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='MODEL_OPTION_PRODUCT_CONTEXT_REQUIRED';
  END IF;
  SELECT publication.publication_id INTO resolved_publication_id
  FROM platform.site_release_model_catalog_publication publication
  JOIN platform.authorization_site_release release
    ON release.release_ref=publication.site_release_ref
   AND release.site_ref=publication.site_id
   AND release.model_option_catalog_ref=publication.model_option_catalog_ref
  WHERE publication.site_id=p_site_id AND publication.site_release_ref=p_site_release_ref
    AND release.state='active';
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT
    platform.site_release_model_catalog_payload(resolved_publication_id),
    (SELECT jsonb_agg(platform.model_option_revision_payload(option.revision_ref)
      ORDER BY surface.position,option.position)
     FROM platform.site_release_model_catalog_surface surface
     JOIN platform.site_release_model_catalog_option option
       ON option.publication_id=surface.publication_id AND option.surface_id=surface.surface_id
     WHERE surface.publication_id=resolved_publication_id),
    COALESCE((SELECT array_agg(DISTINCT binding.model_key ORDER BY binding.model_key)
      FROM platform.site_release_model_catalog_option published
      JOIN platform.model_option_role_binding binding ON binding.revision_ref=published.revision_ref
      JOIN platform.site_release_model_catalog_publication publication
        ON publication.publication_id=published.publication_id
      JOIN platform.model_definition_snapshot model
        ON model.import_id=publication.inventory_import_id AND model.model_key=binding.model_key
      JOIN platform.model_definition_availability model_availability
        ON model_availability.model_key=model.model_key AND model_availability.status='active'
      JOIN platform.model_provider_binding_snapshot provider_binding
        ON provider_binding.import_id=publication.inventory_import_id
       AND provider_binding.model_key=model.model_key AND provider_binding.enabled
      JOIN platform.model_provider_snapshot provider
        ON provider.import_id=provider_binding.import_id AND provider.provider_key=provider_binding.provider_key
      JOIN platform.model_provider_availability provider_availability
        ON provider_availability.provider_key=provider.provider_key
       AND provider_availability.status='active'
       AND provider_availability.health IN ('healthy','degraded')
      WHERE published.publication_id=resolved_publication_id AND model.enabled),ARRAY[]::TEXT[]);
END $$;

REVOKE ALL ON platform.model_option_materialization,platform.model_option_revision,
  platform.model_option_materialized_revision,platform.model_option_role_binding,
  platform.site_release_model_catalog_publication,platform.site_release_model_catalog_surface,
  platform.site_release_model_catalog_option FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.model_option_revision_payload(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.site_release_model_catalog_payload(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.load_model_option_inventory(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.load_model_option_revisions(TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.materialize_model_options(UUID,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.publish_site_release_model_catalog(UUID,JSONB,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.resolve_product_model_option_catalog(TEXT,TEXT) FROM PUBLIC;
