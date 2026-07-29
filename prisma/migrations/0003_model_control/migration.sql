SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- These immutable predicates are shared by the JSON import boundary and the
-- snapshot tables.  Keeping one SQL definition prevents the function path and
-- direct migrator writes from accepting different canonical values.
CREATE FUNCTION platform.model_identifier_is_valid(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN
  value ~ '^[a-z0-9][a-z0-9._:-]{0,127}$';

CREATE FUNCTION platform.model_text_is_valid(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN
  char_length(value) BETWEEN 1 AND 512 AND value !~ '[[:cntrl:]]';

CREATE FUNCTION platform.model_secret_reference_is_valid(value TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN
  value ~ '^(secret|vault|env)://[A-Za-z0-9._:/-]+$';

CREATE FUNCTION platform.model_identifier_array_is_canonical(value TEXT[], required BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE RETURN
  (NOT required OR cardinality(value) > 0)
  AND NOT EXISTS (
    SELECT 1 FROM unnest(value) item WHERE NOT platform.model_identifier_is_valid(item)
  )
  AND value = ARRAY(SELECT item FROM unnest(value) item ORDER BY item COLLATE "C");

CREATE FUNCTION platform.model_json_identifier_array_is_canonical(value JSONB, required BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;
  IF (required AND jsonb_array_length(value)=0)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(value) item
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item#>>'{}')
     )
     OR EXISTS (
       SELECT 1 FROM (
         SELECT item#>>'{}' AS value,
           lag(item#>>'{}') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(value) WITH ORDINALITY element(item,ordinal)
       ) ordered
       WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END $$;

CREATE TABLE platform.model_inventory_import (
  import_id UUID PRIMARY KEY,
  source_digest CHAR(64) NOT NULL UNIQUE CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy-kokoro-model','platform-native')),
  source_reference TEXT NOT NULL CHECK (platform.model_text_is_valid(source_reference)),
  canonical_payload JSONB NOT NULL,
  counts JSONB NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_id, source_digest)
);
CREATE TABLE platform.model_inventory_activation (
  activation_id UUID PRIMARY KEY,
  target_import_id UUID NOT NULL,
  target_digest CHAR(64) NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision >= 0),
  activated_revision BIGINT NOT NULL UNIQUE CHECK (activated_revision = expected_revision + 1),
  activated_by TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (activation_id, target_import_id, activated_revision),
  FOREIGN KEY (target_import_id, target_digest) REFERENCES platform.model_inventory_import(import_id, source_digest)
);
CREATE TABLE platform.model_inventory_pointer (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton IS TRUE),
  import_id UUID NOT NULL REFERENCES platform.model_inventory_import(import_id),
  activation_id UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (activation_id, import_id, revision) REFERENCES platform.model_inventory_activation(activation_id, target_import_id, activated_revision)
);
CREATE TABLE platform.model_provider_snapshot (
  import_id UUID NOT NULL REFERENCES platform.model_inventory_import(import_id),
  provider_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(provider_key)),
  provider TEXT NOT NULL CHECK (platform.model_identifier_is_valid(provider)),
  account_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(account_key)),
  secret_ref TEXT NOT NULL CHECK (platform.model_secret_reference_is_valid(secret_ref)),
  adapter_kind TEXT NOT NULL CHECK (adapter_kind IN ('litellm','direct')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 10000),
  PRIMARY KEY (import_id, provider_key),
  UNIQUE (import_id, provider, account_key)
);
CREATE TABLE platform.model_definition_snapshot (
  import_id UUID NOT NULL REFERENCES platform.model_inventory_import(import_id),
  model_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(model_key)),
  display_name TEXT NOT NULL CHECK (platform.model_text_is_valid(display_name)),
  input_modalities TEXT[] NOT NULL CHECK (platform.model_identifier_array_is_canonical(input_modalities, TRUE)),
  output_modalities TEXT[] NOT NULL CHECK (platform.model_identifier_array_is_canonical(output_modalities, TRUE)),
  capabilities TEXT[] NOT NULL CHECK (platform.model_identifier_array_is_canonical(capabilities, TRUE)),
  context_window INTEGER CHECK (context_window IS NULL OR context_window BETWEEN 1 AND 2147483647),
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (import_id, model_key)
);
CREATE TABLE platform.model_provider_binding_snapshot (
  import_id UUID NOT NULL REFERENCES platform.model_inventory_import(import_id),
  binding_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(binding_key)),
  model_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(model_key)),
  provider_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(provider_key)),
  upstream_model TEXT NOT NULL CHECK (platform.model_text_is_valid(upstream_model)),
  gateway_model_name TEXT NOT NULL CHECK (gateway_model_name ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$'),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 10000),
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (import_id, binding_key),
  UNIQUE (import_id, model_key, provider_key, upstream_model),
  UNIQUE (import_id, gateway_model_name),
  FOREIGN KEY (import_id, model_key) REFERENCES platform.model_definition_snapshot(import_id, model_key),
  FOREIGN KEY (import_id, provider_key) REFERENCES platform.model_provider_snapshot(import_id, provider_key)
);
CREATE TABLE platform.model_product_route_snapshot (
  import_id UUID NOT NULL REFERENCES platform.model_inventory_import(import_id),
  product TEXT NOT NULL CHECK (product IN ('chat','music','image','video')),
  route_role TEXT NOT NULL CHECK (route_role IN ('main','generation')),
  model_key TEXT NOT NULL CHECK (platform.model_identifier_is_valid(model_key)),
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 10000),
  required_capabilities TEXT[] NOT NULL CHECK (platform.model_identifier_array_is_canonical(required_capabilities, TRUE)),
  PRIMARY KEY (import_id, product, route_role, position),
  UNIQUE (import_id, product, route_role, model_key),
  FOREIGN KEY (import_id, model_key) REFERENCES platform.model_definition_snapshot(import_id, model_key)
);
CREATE TABLE platform.model_provider_availability (
  provider_key TEXT PRIMARY KEY CHECK (platform.model_identifier_is_valid(provider_key)),
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  health TEXT NOT NULL CHECK (health IN ('unknown','healthy','degraded','down')),
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  observation_ref TEXT CHECK (observation_ref IS NULL OR platform.model_text_is_valid(observation_ref)),
  observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE platform.model_definition_availability (
  model_key TEXT PRIMARY KEY CHECK (platform.model_identifier_is_valid(model_key)),
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE platform.model_provider_availability_report (
  report_id UUID PRIMARY KEY,
  provider_key TEXT NOT NULL REFERENCES platform.model_provider_availability(provider_key),
  requested_status TEXT NOT NULL CHECK (requested_status IN ('active','disabled')),
  requested_health TEXT NOT NULL CHECK (requested_health IN ('unknown','healthy','degraded','down')),
  expected_epoch BIGINT NOT NULL CHECK (expected_epoch >= 0),
  applied_epoch BIGINT NOT NULL CHECK (applied_epoch = expected_epoch + 1),
  observation_ref TEXT CHECK (observation_ref IS NULL OR platform.model_text_is_valid(observation_ref)),
  observed_at TIMESTAMPTZ,
  reported_by TEXT NOT NULL,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_key, applied_epoch)
);

CREATE TABLE platform.model_site_policy_revision (
  site_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('chat','music','image','video')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  change_id UUID NOT NULL,
  policy_digest CHAR(64) NOT NULL CHECK (policy_digest ~ '^[a-f0-9]{64}$'),
  catalog_mode TEXT NOT NULL CHECK (catalog_mode IN ('follow_active','pinned')),
  catalog_digest CHAR(64),
  enabled BOOLEAN NOT NULL,
  assignment_mode TEXT NOT NULL CHECK (assignment_mode IN ('inherit','replace')),
  canonical_payload JSONB NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, product, revision),
  UNIQUE (site_id, product, change_id),
  UNIQUE (site_id, product, revision, policy_digest),
  FOREIGN KEY (catalog_digest) REFERENCES platform.model_inventory_import(source_digest),
  CHECK ((catalog_mode='follow_active' AND catalog_digest IS NULL AND assignment_mode='inherit') OR (catalog_mode='pinned' AND catalog_digest IS NOT NULL))
);
CREATE TABLE platform.model_site_assignment_revision (
  site_id TEXT NOT NULL,
  product TEXT NOT NULL,
  policy_revision BIGINT NOT NULL,
  route_role TEXT NOT NULL CHECK (route_role IN ('main','generation')),
  model_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 10000),
  required_capabilities TEXT[] NOT NULL,
  enabled BOOLEAN NOT NULL,
  PRIMARY KEY (site_id, product, policy_revision, route_role, position),
  UNIQUE (site_id, product, policy_revision, route_role, model_key),
  FOREIGN KEY (site_id, product, policy_revision) REFERENCES platform.model_site_policy_revision(site_id, product, revision)
);
CREATE TABLE platform.model_site_policy_pointer (
  site_id TEXT NOT NULL,
  product TEXT NOT NULL,
  revision BIGINT NOT NULL,
  policy_digest CHAR(64) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, product),
  FOREIGN KEY (site_id, product, revision, policy_digest) REFERENCES platform.model_site_policy_revision(site_id, product, revision, policy_digest)
);

CREATE TABLE platform.model_selection_decision (
  decision_id UUID PRIMARY KEY,
  decision_digest CHAR(64) NOT NULL CHECK (decision_digest ~ '^[a-f0-9]{64}$'),
  site_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('chat','music','image','video')),
  route_role TEXT NOT NULL CHECK (route_role IN ('main','generation')),
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  required_capabilities JSONB NOT NULL CHECK (jsonb_typeof(required_capabilities) = 'array'),
  inventory_digest CHAR(64) NOT NULL CHECK (inventory_digest ~ '^[a-f0-9]{64}$'),
  policy_revision BIGINT NOT NULL CHECK (policy_revision >= 0),
  selected_model_key TEXT,
  selected_binding_key TEXT,
  selected_route JSONB,
  candidate_binding_keys JSONB NOT NULL CHECK (jsonb_typeof(candidate_binding_keys) = 'array'),
  rejections JSONB NOT NULL CHECK (jsonb_typeof(rejections) = 'array'),
  reason TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (inventory_digest) REFERENCES platform.model_inventory_import(source_digest),
  CHECK (
    (selected_model_key IS NULL AND selected_binding_key IS NULL AND selected_route IS NULL)
    OR (
      selected_model_key IS NOT NULL AND selected_binding_key IS NOT NULL
      AND jsonb_typeof(selected_route) = 'object'
      AND selected_route->>'modelKey' = selected_model_key
      AND selected_route->>'bindingKey' = selected_binding_key
      AND selected_route->>'executionBoundary' = 'model_gateway'
    )
  )
);
CREATE INDEX model_selection_site_time_idx ON platform.model_selection_decision(site_id, decided_at DESC);

CREATE FUNCTION platform.validate_model_route_capabilities() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE model_capabilities TEXT[];
BEGIN
  SELECT capabilities INTO model_capabilities FROM platform.model_definition_snapshot
   WHERE import_id=NEW.import_id AND model_key=NEW.model_key;
  IF model_capabilities IS NULL OR NOT (NEW.required_capabilities <@ model_capabilities) THEN
    RAISE EXCEPTION 'model route capability mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER model_product_route_capabilities BEFORE INSERT ON platform.model_product_route_snapshot FOR EACH ROW EXECUTE FUNCTION platform.validate_model_route_capabilities();

CREATE FUNCTION platform.import_model_inventory(
  p_import_id UUID, p_source_digest TEXT, p_canonical_json TEXT, p_counts JSONB,
  p_provider_availability JSONB, p_imported_by TEXT
) RETURNS TABLE (result_import_id UUID, result_source_digest TEXT, result_counts JSONB, replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  canonical_payload JSONB;
  existing_import platform.model_inventory_import%ROWTYPE;
  product_name TEXT;
BEGIN
  IF current_setting('app.operation', true) IS DISTINCT FROM 'model.inventory.import'
     OR current_setting('app.workload_kind', true) IS DISTINCT FROM 'admin_workload'
     OR current_setting('app.actor_kind', true) IS NULL
     OR current_setting('app.actor_kind', true) NOT IN ('operator', 'workload')
     OR NULLIF(current_setting('app.subject_id', true), '') IS NULL
     OR p_imported_by IS DISTINCT FROM current_setting('app.subject_id', true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_INVENTORY_IMPORT_CONTEXT_REQUIRED';
  END IF;
  IF p_canonical_json IS NULL OR p_source_digest IS NULL OR p_source_digest !~ '^[a-f0-9]{64}$'
     OR encode(sha256(convert_to(p_canonical_json, 'UTF8')), 'hex') <> p_source_digest THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_DIGEST_MISMATCH';
  END IF;
  canonical_payload := p_canonical_json::JSONB;
  IF jsonb_typeof(canonical_payload) IS DISTINCT FROM 'object'
     OR NOT (canonical_payload ?& ARRAY['schemaVersion','source','providers','models','bindings','productRoutes'])
     OR canonical_payload - ARRAY['schemaVersion','source','providers','models','bindings','productRoutes']::TEXT[] <> '{}'::JSONB
     OR canonical_payload->>'schemaVersion' IS DISTINCT FROM '1'
     OR jsonb_typeof(canonical_payload->'source') IS DISTINCT FROM 'object'
     OR NOT ((canonical_payload->'source') ?& ARRAY['kind','reference'])
     OR (canonical_payload->'source') - ARRAY['kind','reference']::TEXT[] <> '{}'::JSONB
     OR canonical_payload#>>'{source,kind}' IS NULL
     OR canonical_payload#>>'{source,kind}' NOT IN ('legacy-kokoro-model','platform-native')
     OR NULLIF(canonical_payload#>>'{source,reference}', '') IS NULL
     OR jsonb_typeof(canonical_payload->'providers') IS DISTINCT FROM 'array'
     OR jsonb_typeof(canonical_payload->'models') IS DISTINCT FROM 'array'
     OR jsonb_typeof(canonical_payload->'bindings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(canonical_payload->'productRoutes') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_PAYLOAD_INVALID';
  END IF;
  IF EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'providers') provider(item)
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR NOT (item ?& ARRAY['key','provider','accountKey','secretRef','adapterKind','priority'])
          OR item - ARRAY['key','provider','accountKey','secretRef','adapterKind','priority']::TEXT[] <> '{}'::JSONB
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'models') model(item)
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR NOT (item ?& ARRAY['key','displayName','inputModalities','outputModalities','capabilities','contextWindow','enabled'])
          OR item - ARRAY['key','displayName','inputModalities','outputModalities','capabilities','contextWindow','enabled']::TEXT[] <> '{}'::JSONB
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') binding(item)
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR NOT (item ?& ARRAY['key','modelKey','providerKey','upstreamModel','gatewayModelName','priority','enabled'])
          OR item - ARRAY['key','modelKey','providerKey','upstreamModel','gatewayModelName','priority','enabled']::TEXT[] <> '{}'::JSONB
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR NOT (item ?& ARRAY['product','role','modelKey','position','requiredCapabilities'])
          OR item - ARRAY['product','role','modelKey','position','requiredCapabilities']::TEXT[] <> '{}'::JSONB
  ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_PAYLOAD_UNKNOWN_FIELD';
  END IF;
  IF NOT platform.model_text_is_valid(canonical_payload#>>'{source,reference}')
     OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'providers') provider(item)
       WHERE jsonb_typeof(item->'key') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'key')
          OR jsonb_typeof(item->'provider') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'provider')
          OR jsonb_typeof(item->'accountKey') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'accountKey')
          OR jsonb_typeof(item->'secretRef') IS DISTINCT FROM 'string'
          OR NOT platform.model_secret_reference_is_valid(item->>'secretRef')
          OR jsonb_typeof(item->'adapterKind') IS DISTINCT FROM 'string'
          OR item->>'adapterKind' NOT IN ('litellm','direct')
          OR jsonb_typeof(item->'priority') IS DISTINCT FROM 'number'
          OR item->>'priority' !~ '^(0|[1-9][0-9]{0,4})$'
          OR (item->>'priority')::INTEGER NOT BETWEEN 0 AND 10000
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'models') model(item)
       WHERE jsonb_typeof(item->'key') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'key')
          OR jsonb_typeof(item->'displayName') IS DISTINCT FROM 'string'
          OR NOT platform.model_text_is_valid(item->>'displayName')
          OR NOT platform.model_json_identifier_array_is_canonical(item->'inputModalities',TRUE)
          OR NOT platform.model_json_identifier_array_is_canonical(item->'outputModalities',TRUE)
          OR NOT platform.model_json_identifier_array_is_canonical(item->'capabilities',TRUE)
          OR NOT (
            item->'contextWindow'='null'::JSONB
            OR (
              jsonb_typeof(item->'contextWindow')='number'
              AND item->>'contextWindow' ~ '^[1-9][0-9]{0,9}$'
              AND (item->>'contextWindow')::BIGINT BETWEEN 1 AND 2147483647
            )
          )
          OR jsonb_typeof(item->'enabled') IS DISTINCT FROM 'boolean'
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') binding(item)
       WHERE jsonb_typeof(item->'key') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'key')
          OR jsonb_typeof(item->'modelKey') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'modelKey')
          OR jsonb_typeof(item->'providerKey') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'providerKey')
          OR jsonb_typeof(item->'upstreamModel') IS DISTINCT FROM 'string'
          OR NOT platform.model_text_is_valid(item->>'upstreamModel')
          OR jsonb_typeof(item->'gatewayModelName') IS DISTINCT FROM 'string'
          OR item->>'gatewayModelName' !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$'
          OR jsonb_typeof(item->'priority') IS DISTINCT FROM 'number'
          OR item->>'priority' !~ '^(0|[1-9][0-9]{0,4})$'
          OR (item->>'priority')::INTEGER NOT BETWEEN 0 AND 10000
          OR jsonb_typeof(item->'enabled') IS DISTINCT FROM 'boolean'
     ) OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
       WHERE jsonb_typeof(item->'product') IS DISTINCT FROM 'string'
          OR item->>'product' NOT IN ('chat','music','image','video')
          OR jsonb_typeof(item->'role') IS DISTINCT FROM 'string'
          OR item->>'role' NOT IN ('main','generation')
          OR jsonb_typeof(item->'modelKey') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'modelKey')
          OR jsonb_typeof(item->'position') IS DISTINCT FROM 'number'
          OR item->>'position' !~ '^(0|[1-9][0-9]{0,4})$'
          OR (item->>'position')::INTEGER NOT BETWEEN 0 AND 10000
          OR NOT platform.model_json_identifier_array_is_canonical(item->'requiredCapabilities',TRUE)
     ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_PAYLOAD_NON_CANONICAL';
  END IF;
  IF EXISTS(
       SELECT 1 FROM (
         SELECT item->>'key' AS value,lag(item->>'key') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(canonical_payload->'providers') WITH ORDINALITY element(item,ordinal)
       ) ordered WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) OR EXISTS(
       SELECT 1 FROM (
         SELECT item->>'key' AS value,lag(item->>'key') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(canonical_payload->'models') WITH ORDINALITY element(item,ordinal)
       ) ordered WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) OR EXISTS(
       SELECT 1 FROM (
         SELECT item->>'key' AS value,lag(item->>'key') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(canonical_payload->'bindings') WITH ORDINALITY element(item,ordinal)
       ) ordered WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) OR EXISTS(
       SELECT 1 FROM (
         SELECT concat(item->>'product',':',item->>'role',':',lpad(item->>'position',6,'0')) AS value,
           lag(concat(item->>'product',':',item->>'role',':',lpad(item->>'position',6,'0')))
             OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(canonical_payload->'productRoutes') WITH ORDINALITY element(item,ordinal)
       ) ordered WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_PAYLOAD_NON_CANONICAL';
  END IF;
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'providers') first(item)
       JOIN jsonb_array_elements(canonical_payload->'providers') second(other)
         ON item->>'provider'=other->>'provider' AND item->>'accountKey'=other->>'accountKey'
        AND item->>'key'<other->>'key'
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') first(item)
       JOIN jsonb_array_elements(canonical_payload->'bindings') second(other)
         ON item->>'modelKey'=other->>'modelKey' AND item->>'providerKey'=other->>'providerKey'
        AND item->>'upstreamModel'=other->>'upstreamModel' AND item->>'key'<other->>'key'
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') first(item)
       JOIN jsonb_array_elements(canonical_payload->'bindings') second(other)
         ON item->>'gatewayModelName'=other->>'gatewayModelName' AND item->>'key'<other->>'key'
     ) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') first(item)
       JOIN jsonb_array_elements(canonical_payload->'productRoutes') second(other)
         ON item->>'product'=other->>'product' AND item->>'role'=other->>'role'
        AND item->>'modelKey'=other->>'modelKey' AND item->>'position'<>other->>'position'
     ) THEN
    RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='MODEL_INVENTORY_PAYLOAD_NON_CANONICAL';
  END IF;
  IF p_counts IS NULL OR p_counts IS DISTINCT FROM jsonb_build_object(
    'providers',jsonb_array_length(canonical_payload->'providers'),
    'models',jsonb_array_length(canonical_payload->'models'),
    'bindings',jsonb_array_length(canonical_payload->'bindings'),
    'productRoutes',jsonb_array_length(canonical_payload->'productRoutes')
  ) THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_COUNTS_MISMATCH'; END IF;
  IF jsonb_typeof(p_provider_availability) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_provider_availability)<>jsonb_array_length(canonical_payload->'providers')
     OR EXISTS(
       SELECT 1 FROM jsonb_array_elements(p_provider_availability) availability(item)
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR NOT (item ?& ARRAY['providerKey','status','health','epoch','observationRef','observedAt'])
          OR item - ARRAY['providerKey','status','health','epoch','observationRef','observedAt']::TEXT[] <> '{}'::JSONB
          OR jsonb_typeof(item->'providerKey') IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item->>'providerKey')
          OR item->>'status' IS NULL OR item->>'status' NOT IN ('active','disabled')
          OR item->>'health' IS NULL OR item->>'health' NOT IN ('unknown','healthy','degraded','down')
          OR item->>'epoch' IS NULL OR item->>'epoch' !~ '^(0|[1-9][0-9]*)$'
          OR NOT (
            item->'observationRef'='null'::JSONB
            OR (jsonb_typeof(item->'observationRef')='string' AND platform.model_text_is_valid(item->>'observationRef'))
          )
          OR NOT (
            item->'observedAt'='null'::JSONB
            OR (jsonb_typeof(item->'observedAt')='string' AND item->>'observedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$')
          )
          OR NOT EXISTS(
            SELECT 1 FROM jsonb_array_elements(canonical_payload->'providers') provider(provider_item)
            WHERE provider_item->>'key'=item->>'providerKey'
          )
     )
     OR (SELECT count(DISTINCT item->>'providerKey') FROM jsonb_array_elements(p_provider_availability) availability(item))
        <>jsonb_array_length(canonical_payload->'providers')
     OR EXISTS(
       SELECT 1 FROM (
         SELECT item->>'providerKey' AS value,
           lag(item->>'providerKey') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(p_provider_availability) WITH ORDINALITY availability(item,ordinal)
       ) ordered WHERE previous IS NOT NULL AND previous COLLATE "C" >= value COLLATE "C"
     ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_PROVIDER_AVAILABILITY_INVALID';
  END IF;
  FOREACH product_name IN ARRAY ARRAY['chat','music','image','video'] LOOP
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
      WHERE item->>'product'=product_name) THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
        WHERE item->>'product'=product_name AND item->>'role'='main' AND item->>'position'='0'
          AND item->'requiredCapabilities' ? 'chat') THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_PRODUCT_MAIN_REQUIRED:'||product_name;
      END IF;
      IF product_name <> 'chat' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
        WHERE item->>'product'=product_name AND item->>'role'='generation' AND item->>'position'='0'
          AND item->'requiredCapabilities' ? (product_name||'.generate')) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_PRODUCT_GENERATION_REQUIRED:'||product_name;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'models') model(item)
    WHERE (item->>'enabled')::BOOLEAN AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') binding(binding_item)
      WHERE binding_item->>'modelKey'=item->>'key' AND (binding_item->>'enabled')::BOOLEAN
    )) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_ENABLED_WITHOUT_BINDING'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(canonical_payload->'bindings') binding(binding_item)
      WHERE binding_item->>'modelKey'=item->>'modelKey')) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_ROUTE_WITHOUT_BINDING';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('kokoro-platform:model-inventory-import:v1',0));
  SELECT imported.* INTO existing_import FROM platform.model_inventory_import imported WHERE imported.import_id=p_import_id;
  IF FOUND THEN
    IF existing_import.source_digest <> p_source_digest THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='MODEL_INVENTORY_IMPORT_ID_CONFLICT'; END IF;
    RETURN QUERY SELECT existing_import.import_id,existing_import.source_digest::TEXT,existing_import.counts,TRUE;
    RETURN;
  END IF;
  SELECT imported.* INTO existing_import FROM platform.model_inventory_import imported WHERE imported.source_digest=p_source_digest;
  IF FOUND THEN
    RETURN QUERY SELECT existing_import.import_id,existing_import.source_digest::TEXT,existing_import.counts,TRUE;
    RETURN;
  END IF;

  INSERT INTO platform.model_inventory_import(import_id,source_digest,schema_version,source_kind,source_reference,canonical_payload,counts,imported_by)
    VALUES(p_import_id,p_source_digest,1,canonical_payload#>>'{source,kind}',canonical_payload#>>'{source,reference}',canonical_payload,p_counts,p_imported_by);
  INSERT INTO platform.model_provider_snapshot(import_id,provider_key,provider,account_key,secret_ref,adapter_kind,priority)
    SELECT p_import_id,item->>'key',item->>'provider',item->>'accountKey',item->>'secretRef',item->>'adapterKind',(item->>'priority')::INTEGER
    FROM jsonb_array_elements(canonical_payload->'providers') provider(item);
  INSERT INTO platform.model_definition_snapshot(import_id,model_key,display_name,input_modalities,output_modalities,capabilities,context_window,enabled)
    SELECT p_import_id,item->>'key',item->>'displayName',ARRAY(SELECT jsonb_array_elements_text(item->'inputModalities')),
      ARRAY(SELECT jsonb_array_elements_text(item->'outputModalities')),ARRAY(SELECT jsonb_array_elements_text(item->'capabilities')),
      CASE WHEN item->'contextWindow'='null'::JSONB THEN NULL ELSE (item->>'contextWindow')::INTEGER END,(item->>'enabled')::BOOLEAN
    FROM jsonb_array_elements(canonical_payload->'models') model(item);
  INSERT INTO platform.model_provider_binding_snapshot(import_id,binding_key,model_key,provider_key,upstream_model,gateway_model_name,priority,enabled)
    SELECT p_import_id,item->>'key',item->>'modelKey',item->>'providerKey',item->>'upstreamModel',item->>'gatewayModelName',(item->>'priority')::INTEGER,(item->>'enabled')::BOOLEAN
    FROM jsonb_array_elements(canonical_payload->'bindings') binding(item);
  INSERT INTO platform.model_product_route_snapshot(import_id,product,route_role,model_key,position,required_capabilities)
    SELECT p_import_id,item->>'product',item->>'role',item->>'modelKey',(item->>'position')::INTEGER,ARRAY(SELECT jsonb_array_elements_text(item->'requiredCapabilities'))
    FROM jsonb_array_elements(canonical_payload->'productRoutes') route(item);
  INSERT INTO platform.model_provider_availability(provider_key,status,health,epoch,observation_ref,observed_at)
    SELECT item->>'providerKey',item->>'status',item->>'health',(item->>'epoch')::BIGINT,
      item->>'observationRef',CASE WHEN item->>'observedAt' IS NULL THEN NULL ELSE (item->>'observedAt')::TIMESTAMPTZ END
    FROM jsonb_array_elements(p_provider_availability) availability(item) ON CONFLICT(provider_key) DO NOTHING;
  INSERT INTO platform.model_definition_availability(model_key,status,epoch)
    SELECT item->>'key','active',0 FROM jsonb_array_elements(canonical_payload->'models') model(item) ON CONFLICT(model_key) DO NOTHING;
  RETURN QUERY SELECT p_import_id,p_source_digest,p_counts,FALSE;
END $$;

CREATE FUNCTION platform.activate_model_inventory(
  p_activation_id UUID, p_target_digest TEXT, p_expected_revision BIGINT, p_activated_by TEXT
) RETURNS TABLE(
  result_activation_id UUID,result_import_id UUID,result_target_digest TEXT,
  result_expected_revision BIGINT,result_activated_revision BIGINT,replayed BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  existing_activation platform.model_inventory_activation%ROWTYPE;
  target_import platform.model_inventory_import%ROWTYPE;
  current_revision BIGINT;
  next_revision BIGINT;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.inventory.activate'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR current_setting('app.actor_kind',true) IS NULL
     OR current_setting('app.actor_kind',true) NOT IN ('operator','workload')
     OR NULLIF(current_setting('app.subject_id',true),'') IS NULL
     OR p_activated_by IS DISTINCT FROM current_setting('app.subject_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_INVENTORY_ACTIVATION_CONTEXT_REQUIRED';
  END IF;
  IF p_expected_revision < 0 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_POINTER_REVISION_INVALID'; END IF;
  IF p_target_digest IS NULL OR p_target_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_INVENTORY_ACTIVATION_TARGET_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kokoro-platform:model-inventory-activation:v1',0));
  SELECT activation.* INTO existing_activation FROM platform.model_inventory_activation activation
    WHERE activation.activation_id=p_activation_id;
  IF FOUND THEN
    IF existing_activation.target_digest<>p_target_digest OR existing_activation.expected_revision<>p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='MODEL_INVENTORY_ACTIVATION_ID_CONFLICT';
    END IF;
    RETURN QUERY SELECT existing_activation.activation_id,existing_activation.target_import_id,
      existing_activation.target_digest::TEXT,existing_activation.expected_revision,
      existing_activation.activated_revision,TRUE;
    RETURN;
  END IF;
  SELECT imported.* INTO target_import FROM platform.model_inventory_import imported
    WHERE imported.source_digest=p_target_digest;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='MODEL_INVENTORY_ACTIVATION_TARGET_NOT_FOUND'; END IF;
  SELECT revision INTO current_revision FROM platform.model_inventory_pointer WHERE singleton IS TRUE FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_revision<>0 THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_POINTER_REVISION_CONFLICT'; END IF;
    next_revision:=1;
  ELSE
    IF current_revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_POINTER_REVISION_CONFLICT'; END IF;
    next_revision:=current_revision+1;
  END IF;
  INSERT INTO platform.model_inventory_activation(
    activation_id,target_import_id,target_digest,expected_revision,activated_revision,activated_by
  ) VALUES(p_activation_id,target_import.import_id,p_target_digest,p_expected_revision,next_revision,p_activated_by);
  IF current_revision IS NULL THEN
    INSERT INTO platform.model_inventory_pointer(singleton,import_id,activation_id,revision)
      VALUES(TRUE,target_import.import_id,p_activation_id,next_revision);
  ELSE
    UPDATE platform.model_inventory_pointer SET import_id=target_import.import_id,activation_id=p_activation_id,
      revision=next_revision,updated_at=now() WHERE singleton IS TRUE AND revision=p_expected_revision;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_POINTER_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN QUERY SELECT p_activation_id,target_import.import_id,p_target_digest,p_expected_revision,next_revision,FALSE;
END $$;

CREATE FUNCTION platform.put_model_site_policy(
  p_change_id UUID, p_policy_digest TEXT, p_policy_json TEXT, p_changed_by TEXT, p_expected_revision BIGINT
) RETURNS TABLE(result_change_id UUID,result_policy_digest TEXT,result_revision BIGINT,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  policy JSONB;
  existing_policy platform.model_site_policy_revision%ROWTYPE;
  site_key TEXT;
  product_key TEXT;
  catalog_mode_value TEXT;
  catalog_digest_value TEXT;
  assignment_mode_value TEXT;
  current_revision BIGINT;
  next_revision BIGINT;
  catalog_import_id UUID;
  cross_site_migration BOOLEAN;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.site-policy.change'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'admin_workload'
     OR current_setting('app.actor_kind',true) IS NULL
     OR current_setting('app.actor_kind',true) NOT IN ('operator','workload')
     OR NULLIF(current_setting('app.subject_id',true),'') IS NULL
     OR p_changed_by IS DISTINCT FROM current_setting('app.subject_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_SITE_POLICY_CONTEXT_REQUIRED';
  END IF;
  IF p_expected_revision < 0 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_SITE_POLICY_REVISION_INVALID'; END IF;
  IF p_policy_json IS NULL OR p_policy_digest IS NULL OR p_policy_digest !~ '^[a-f0-9]{64}$'
     OR encode(sha256(convert_to(p_policy_json,'UTF8')),'hex') <> p_policy_digest THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_SITE_POLICY_DIGEST_MISMATCH';
  END IF;
  policy:=p_policy_json::JSONB;
  site_key:=policy->>'siteId'; product_key:=policy->>'product'; catalog_mode_value:=policy#>>'{catalog,mode}';
  catalog_digest_value:=policy#>>'{catalog,digest}'; assignment_mode_value:=policy->>'assignmentMode';
  cross_site_migration:=NULLIF(current_setting('app.site_id',true),'') IS NULL
    AND current_setting('app.purpose',true)='model_control_migration'
    AND COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'model:site-policy:migrate';
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
     OR NOT (policy ?& ARRAY['schemaVersion','siteId','product','enabled','catalog','assignmentMode','assignments'])
     OR policy - ARRAY['schemaVersion','siteId','product','enabled','catalog','assignmentMode','assignments']::TEXT[] <> '{}'::JSONB
     OR jsonb_typeof(policy->'catalog') IS DISTINCT FROM 'object'
     OR NOT ((policy->'catalog') ?& ARRAY['mode','digest'])
     OR (policy->'catalog') - ARRAY['mode','digest']::TEXT[] <> '{}'::JSONB
     OR policy->>'schemaVersion' IS DISTINCT FROM '1' OR NULLIF(site_key,'') IS NULL
     OR product_key IS NULL OR product_key NOT IN ('chat','music','image','video')
     OR policy->>'enabled' IS NULL OR policy->>'enabled' NOT IN ('true','false')
     OR catalog_mode_value IS NULL OR catalog_mode_value NOT IN ('follow_active','pinned')
     OR assignment_mode_value IS NULL OR assignment_mode_value NOT IN ('inherit','replace')
     OR jsonb_typeof(policy->'assignments') IS DISTINCT FROM 'array'
     OR (current_setting('app.site_id',true) IS DISTINCT FROM site_key AND NOT cross_site_migration) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_SITE_POLICY_PAYLOAD_INVALID';
  END IF;
  IF EXISTS(
    SELECT 1 FROM jsonb_array_elements(policy->'assignments') assignment(item)
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR NOT (item ?& ARRAY['role','modelKey','position','requiredCapabilities','enabled'])
       OR item - ARRAY['role','modelKey','position','requiredCapabilities','enabled']::TEXT[] <> '{}'::JSONB
  ) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_SITE_POLICY_UNKNOWN_FIELD';
  END IF;
  IF cross_site_migration THEN PERFORM set_config('app.site_id',site_key,true); END IF;
  IF catalog_mode_value='follow_active' AND (catalog_digest_value IS NOT NULL OR assignment_mode_value<>'inherit') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_ACTIVE_POLICY_INVALID';
  END IF;
  IF catalog_mode_value='pinned' AND (catalog_digest_value IS NULL OR catalog_digest_value !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_PINNED_CATALOG_REQUIRED';
  END IF;
  IF assignment_mode_value='inherit' AND jsonb_array_length(policy->'assignments')<>0 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_INHERIT_ASSIGNMENTS_FORBIDDEN';
  END IF;

  IF catalog_mode_value='follow_active' THEN
    SELECT import_id INTO catalog_import_id FROM platform.model_inventory_pointer WHERE singleton IS TRUE;
  ELSE
    SELECT import_id INTO catalog_import_id FROM platform.model_inventory_import WHERE source_digest=catalog_digest_value;
  END IF;
  IF catalog_import_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='MODEL_SITE_CATALOG_NOT_FOUND'; END IF;
  IF assignment_mode_value='replace' AND (policy->>'enabled')::BOOLEAN THEN
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'assignments') assignment(item)
      WHERE item->>'role'='main' AND item->>'position'='0' AND (item->>'enabled')::BOOLEAN
        AND item->'requiredCapabilities' ? 'chat') THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_MAIN_REQUIRED';
    END IF;
    IF product_key<>'chat' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'assignments') assignment(item)
      WHERE item->>'role'='generation' AND item->>'position'='0' AND (item->>'enabled')::BOOLEAN
        AND item->'requiredCapabilities' ? (product_key||'.generate')) THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_GENERATION_REQUIRED';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'assignments') assignment(item)
    LEFT JOIN platform.model_definition_snapshot model ON model.import_id=catalog_import_id AND model.model_key=item->>'modelKey'
    WHERE model.model_key IS NULL OR NOT (ARRAY(SELECT jsonb_array_elements_text(item->'requiredCapabilities')) <@ model.capabilities)
      OR NOT EXISTS (SELECT 1 FROM platform.model_provider_binding_snapshot binding
        WHERE binding.import_id=catalog_import_id AND binding.model_key=item->>'modelKey')) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='MODEL_SITE_ASSIGNMENT_CATALOG_MISMATCH';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('kokoro-platform:model-site-policy:'||site_key||':'||product_key,0));
  SELECT revision_row.* INTO existing_policy FROM platform.model_site_policy_revision revision_row
    WHERE revision_row.site_id=site_key AND revision_row.product=product_key AND revision_row.change_id=p_change_id;
  IF FOUND THEN
    IF existing_policy.policy_digest<>p_policy_digest OR existing_policy.site_id<>site_key OR existing_policy.product<>product_key THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='MODEL_SITE_POLICY_CHANGE_ID_CONFLICT';
    END IF;
    RETURN QUERY SELECT existing_policy.change_id,existing_policy.policy_digest::TEXT,existing_policy.revision,TRUE;
    RETURN;
  END IF;
  SELECT revision INTO current_revision FROM platform.model_site_policy_pointer WHERE site_id=site_key AND product=product_key FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_revision<>0 THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_SITE_POLICY_REVISION_CONFLICT'; END IF;
    next_revision:=1;
  ELSE
    IF current_revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_SITE_POLICY_REVISION_CONFLICT'; END IF;
    next_revision:=current_revision+1;
  END IF;
  INSERT INTO platform.model_site_policy_revision(site_id,product,revision,change_id,policy_digest,catalog_mode,catalog_digest,enabled,assignment_mode,canonical_payload,changed_by)
    VALUES(site_key,product_key,next_revision,p_change_id,p_policy_digest,catalog_mode_value,catalog_digest_value,(policy->>'enabled')::BOOLEAN,assignment_mode_value,policy,p_changed_by);
  INSERT INTO platform.model_site_assignment_revision(site_id,product,policy_revision,route_role,model_key,position,required_capabilities,enabled)
    SELECT site_key,product_key,next_revision,item->>'role',item->>'modelKey',(item->>'position')::INTEGER,
      ARRAY(SELECT jsonb_array_elements_text(item->'requiredCapabilities')),(item->>'enabled')::BOOLEAN
    FROM jsonb_array_elements(policy->'assignments') assignment(item);
  IF current_revision IS NULL THEN
    INSERT INTO platform.model_site_policy_pointer(site_id,product,revision,policy_digest) VALUES(site_key,product_key,next_revision,p_policy_digest);
  ELSE
    UPDATE platform.model_site_policy_pointer SET revision=next_revision,policy_digest=p_policy_digest,updated_at=now()
      WHERE site_id=site_key AND product=product_key AND revision=p_expected_revision;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_SITE_POLICY_REVISION_CONFLICT'; END IF;
  END IF;
  RETURN QUERY SELECT p_change_id,p_policy_digest,next_revision,FALSE;
END $$;

CREATE FUNCTION platform.resolve_model_candidates(
  p_site_id TEXT, p_product TEXT, p_route_role TEXT
) RETURNS TABLE(
  result_inventory_digest TEXT,result_policy_status TEXT,result_policy_revision BIGINT,
  result_model_key TEXT,result_binding_key TEXT,result_provider_key TEXT,result_gateway_model_name TEXT,
  result_execution_boundary TEXT,result_position INTEGER,result_binding_priority INTEGER,result_provider_priority INTEGER,
  result_input_modalities TEXT[],result_output_modalities TEXT[],result_capabilities TEXT[],result_context_window INTEGER,
  result_provider_status TEXT,result_provider_health TEXT,result_model_status TEXT,result_binding_status TEXT,
  result_route_required_capabilities TEXT[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.policy.resolve'
     OR current_setting('app.site_id',true) IS DISTINCT FROM p_site_id
     OR current_setting('app.workload_kind',true) IS NULL
     OR p_product NOT IN ('chat','music','image','video')
     OR p_route_role NOT IN ('main','generation') THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_CANDIDATE_PROJECTION_CONTEXT_REQUIRED';
  END IF;
  RETURN QUERY WITH seed AS (
    SELECT TRUE AS singleton
  ), active AS (
    SELECT pointer.import_id,imported.source_digest
    FROM platform.model_inventory_pointer pointer
    JOIN platform.model_inventory_import imported ON imported.import_id=pointer.import_id
    WHERE pointer.singleton IS TRUE
  ), policy AS (
    SELECT revision_row.*
    FROM platform.model_site_policy_pointer pointer
    JOIN platform.model_site_policy_revision revision_row
      ON revision_row.site_id=pointer.site_id AND revision_row.product=pointer.product AND revision_row.revision=pointer.revision
    WHERE pointer.site_id=p_site_id AND pointer.product=p_product
  ), catalog AS (
    SELECT CASE WHEN policy.catalog_mode='pinned' THEN pinned.import_id ELSE active.import_id END AS import_id,
           CASE WHEN policy.catalog_mode='pinned' THEN pinned.source_digest ELSE active.source_digest END AS source_digest
    FROM seed LEFT JOIN active ON TRUE LEFT JOIN policy ON TRUE
    LEFT JOIN platform.model_inventory_import pinned ON policy.catalog_mode='pinned' AND pinned.source_digest=policy.catalog_digest
  ), routes AS (
    SELECT route.model_key,route.position,route.required_capabilities
    FROM platform.model_product_route_snapshot route JOIN catalog ON catalog.import_id=route.import_id
    JOIN policy ON policy.assignment_mode='inherit' AND policy.enabled=TRUE
    WHERE route.product=p_product AND route.route_role=p_route_role
    UNION ALL
    SELECT assignment.model_key,assignment.position,assignment.required_capabilities
    FROM platform.model_site_assignment_revision assignment
    JOIN policy ON policy.site_id=assignment.site_id AND policy.product=assignment.product AND policy.revision=assignment.policy_revision
      AND policy.assignment_mode='replace' AND policy.enabled=TRUE
    WHERE assignment.route_role=p_route_role AND assignment.enabled=TRUE
  )
  SELECT catalog.source_digest::TEXT,
    CASE WHEN policy.site_id IS NULL THEN 'missing' WHEN policy.enabled THEN 'enabled' ELSE 'disabled' END,
    COALESCE(policy.revision,0),route.model_key,binding.binding_key,provider.provider_key,
    binding.gateway_model_name,'model_gateway',route.position,binding.priority,provider.priority,
    model.input_modalities,model.output_modalities,model.capabilities,model.context_window,
    COALESCE(provider_availability.status,'disabled'),COALESCE(provider_availability.health,'unknown'),
    CASE WHEN model.enabled IS NOT TRUE THEN 'disabled' ELSE COALESCE(model_availability.status,'disabled') END,
    CASE WHEN binding.enabled THEN 'active' ELSE 'disabled' END,route.required_capabilities
  FROM catalog LEFT JOIN policy ON TRUE LEFT JOIN routes ON TRUE
  LEFT JOIN platform.model_definition_snapshot model ON model.import_id=catalog.import_id AND model.model_key=route.model_key
  LEFT JOIN platform.model_provider_binding_snapshot binding ON binding.import_id=catalog.import_id AND binding.model_key=model.model_key
  LEFT JOIN platform.model_provider_snapshot provider ON provider.import_id=catalog.import_id AND provider.provider_key=binding.provider_key
  LEFT JOIN platform.model_provider_availability provider_availability ON provider_availability.provider_key=provider.provider_key
  LEFT JOIN platform.model_definition_availability model_availability ON model_availability.model_key=model.model_key
  WHERE catalog.import_id IS NOT NULL
  ORDER BY route.position,binding.priority,provider.priority,binding.binding_key;
END $$;

CREATE FUNCTION platform.find_model_selection_decision(
  p_decision_id UUID
) RETURNS SETOF platform.model_selection_decision
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.policy.resolve'
     OR NULLIF(current_setting('app.site_id',true),'') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_DECISION_PROJECTION_CONTEXT_REQUIRED';
  END IF;
  RETURN QUERY SELECT decision.* FROM platform.model_selection_decision decision
    WHERE decision.decision_id=p_decision_id
      AND decision.site_id=current_setting('app.site_id',true);
END $$;

CREATE FUNCTION platform.report_model_provider_availability(
  p_report_id UUID,p_provider_key TEXT,p_status TEXT,p_health TEXT,p_expected_epoch BIGINT,
  p_observation_ref TEXT,p_observed_at TIMESTAMPTZ,p_reported_by TEXT
) RETURNS TABLE(result_report_id UUID,result_provider_key TEXT,result_applied_epoch BIGINT,replayed BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, platform AS $$
DECLARE
  existing_report platform.model_provider_availability_report%ROWTYPE;
  applied_epoch BIGINT;
BEGIN
  IF current_setting('app.operation',true) IS DISTINCT FROM 'model.availability.report'
     OR current_setting('app.workload_kind',true) IS DISTINCT FROM 'platform_worker'
     OR current_setting('app.actor_kind',true) IS DISTINCT FROM 'workload'
     OR NULLIF(current_setting('app.site_id',true),'') IS NOT NULL
     OR NULLIF(current_setting('app.workspace_id',true),'') IS NOT NULL
     OR NULLIF(current_setting('app.project_id',true),'') IS NOT NULL
     OR current_setting('app.purpose',true) IS DISTINCT FROM 'model_health_observation'
     OR NOT (COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'model:availability:write')
     OR p_reported_by IS DISTINCT FROM current_setting('app.subject_id',true) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='MODEL_AVAILABILITY_REPORT_CONTEXT_REQUIRED';
  END IF;
  IF p_report_id IS NULL OR p_status IS NULL OR p_status NOT IN ('active','disabled')
     OR p_health IS NULL OR p_health NOT IN ('unknown','healthy','degraded','down')
     OR p_expected_epoch IS NULL OR p_expected_epoch<0
     OR p_provider_key IS NULL OR p_provider_key !~ '^[a-z0-9][a-z0-9._:-]{0,127}$'
     OR NULLIF(p_reported_by,'') IS NULL
     OR (p_observation_ref IS NOT NULL AND (length(p_observation_ref)<1 OR length(p_observation_ref)>512)) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='MODEL_AVAILABILITY_REPORT_INVALID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('kokoro-platform:model-provider-availability:'||p_provider_key,0));
  SELECT report.* INTO existing_report FROM platform.model_provider_availability_report report
    WHERE report.report_id=p_report_id;
  IF FOUND THEN
    IF existing_report.provider_key<>p_provider_key
       OR existing_report.requested_status<>p_status OR existing_report.requested_health<>p_health
       OR existing_report.expected_epoch<>p_expected_epoch
       OR existing_report.observation_ref IS DISTINCT FROM p_observation_ref
       OR existing_report.observed_at IS DISTINCT FROM p_observed_at
       OR existing_report.reported_by IS DISTINCT FROM p_reported_by THEN
      RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='MODEL_AVAILABILITY_REPORT_ID_CONFLICT';
    END IF;
    RETURN QUERY SELECT existing_report.report_id,existing_report.provider_key,
      existing_report.applied_epoch,TRUE;
    RETURN;
  END IF;
  UPDATE platform.model_provider_availability
    SET status=p_status,health=p_health,epoch=p_expected_epoch+1,observation_ref=p_observation_ref,
        observed_at=p_observed_at,updated_at=now()
    WHERE provider_key=p_provider_key AND epoch=p_expected_epoch
    RETURNING epoch INTO applied_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='MODEL_AVAILABILITY_EPOCH_CONFLICT'; END IF;
  INSERT INTO platform.model_provider_availability_report(
    report_id,provider_key,requested_status,requested_health,expected_epoch,applied_epoch,
    observation_ref,observed_at,reported_by
  ) VALUES(p_report_id,p_provider_key,p_status,p_health,p_expected_epoch,applied_epoch,
    p_observation_ref,p_observed_at,p_reported_by);
  RETURN QUERY SELECT p_report_id,p_provider_key,applied_epoch,FALSE;
END $$;

CREATE FUNCTION platform.reject_immutable_model_control_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable model-control fact'; END $$;
DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['model_inventory_import','model_inventory_activation','model_provider_snapshot','model_definition_snapshot','model_provider_binding_snapshot','model_product_route_snapshot','model_provider_availability_report','model_site_policy_revision','model_site_assignment_revision','model_selection_decision']
  LOOP EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON platform.%I FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_model_control_update()',table_name,table_name); END LOOP;
END $$;

ALTER TABLE platform.model_site_policy_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_policy_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_assignment_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_assignment_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_policy_pointer ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_site_policy_pointer FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.model_selection_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.model_selection_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY model_site_policy_revision_scope ON platform.model_site_policy_revision USING(site_id=NULLIF(current_setting('app.site_id',true),'')) WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));
CREATE POLICY model_site_assignment_revision_scope ON platform.model_site_assignment_revision USING(site_id=NULLIF(current_setting('app.site_id',true),'')) WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));
CREATE POLICY model_site_policy_pointer_scope ON platform.model_site_policy_pointer USING(site_id=NULLIF(current_setting('app.site_id',true),'')) WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));
CREATE POLICY model_selection_scope ON platform.model_selection_decision USING(site_id=NULLIF(current_setting('app.site_id',true),'')) WITH CHECK(site_id=NULLIF(current_setting('app.site_id',true),''));

REVOKE ALL ON platform.model_inventory_import,platform.model_inventory_activation,platform.model_inventory_pointer,platform.model_provider_snapshot,platform.model_definition_snapshot,platform.model_provider_binding_snapshot,platform.model_product_route_snapshot,platform.model_provider_availability,platform.model_definition_availability,platform.model_provider_availability_report,platform.model_site_policy_revision,platform.model_site_assignment_revision,platform.model_site_policy_pointer,platform.model_selection_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_immutable_model_control_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.validate_model_route_capabilities() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.import_model_inventory(UUID,TEXT,TEXT,JSONB,JSONB,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.activate_model_inventory(UUID,TEXT,BIGINT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.put_model_site_policy(UUID,TEXT,TEXT,TEXT,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.resolve_model_candidates(TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.find_model_selection_decision(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.report_model_provider_availability(UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC;
