-- Close the historical aggregate database authority. The exact workload inventory is:
-- platform_commerce_worker, platform_site_worker, platform_asset_worker,
-- platform_admin_worker, platform_identity_worker, platform_authorization_maintenance,
-- and platform_model_gateway.

DO $retire_aggregate_role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='platform_worker') THEN
    EXECUTE format(
      'REVOKE CONNECT ON DATABASE %I FROM platform_worker',
      current_database()
    );
    REVOKE ALL ON SCHEMA platform FROM platform_worker;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform FROM platform_worker;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA platform FROM platform_worker;
    REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA platform FROM platform_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA platform
      REVOKE ALL ON TABLES FROM platform_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA platform
      REVOKE ALL ON SEQUENCES FROM platform_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA platform
      REVOKE ALL ON FUNCTIONS FROM platform_worker;
  END IF;
END
$retire_aggregate_role$;

DROP POLICY IF EXISTS outbox_worker_select ON platform.outbox_event;
DROP POLICY IF EXISTS outbox_worker_insert ON platform.outbox_event;
DROP POLICY IF EXISTS outbox_worker_update ON platform.outbox_event;

-- Historical RLS policies remain on their original tables, but their aggregate
-- workload fence is rewritten to the one exact authority that owns the table.
DO $split_policy_fences$
DECLARE
  policy_row RECORD;
  replacement_workload TEXT;
  using_expression TEXT;
  check_expression TEXT;
BEGIN
  FOR policy_row IN
    SELECT policy.oid, policy.polname, policy.polrelid, relation.relname,
      pg_get_expr(policy.polqual,policy.polrelid,false) AS using_expression,
      pg_get_expr(policy.polwithcheck,policy.polrelid,false) AS check_expression
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid=policy.polrelid
    JOIN pg_namespace schema_row ON schema_row.oid=relation.relnamespace
    WHERE schema_row.nspname='platform'
      AND (COALESCE(pg_get_expr(policy.polqual,policy.polrelid,false),'') LIKE '%platform_worker%'
        OR COALESCE(pg_get_expr(policy.polwithcheck,policy.polrelid,false),'') LIKE '%platform_worker%')
  LOOP
    replacement_workload := CASE
      WHEN policy_row.relname LIKE 'asset\_%' ESCAPE '\' THEN 'platform_asset_worker'
      WHEN policy_row.relname LIKE 'site\_%' ESCAPE '\' OR policy_row.relname='site'
        THEN 'platform_site_worker'
      WHEN policy_row.relname LIKE 'admin\_%' ESCAPE '\' THEN 'platform_admin_worker'
      ELSE NULL
    END;
    IF replacement_workload IS NULL THEN
      RAISE EXCEPTION 'UNMAPPED_PLATFORM_WORKER_POLICY:%.%',
        policy_row.relname,policy_row.polname;
    END IF;
    using_expression := replace(
      policy_row.using_expression,
      '''platform_worker''',
      quote_literal(replacement_workload)
    );
    check_expression := replace(
      policy_row.check_expression,
      '''platform_worker''',
      quote_literal(replacement_workload)
    );
    EXECUTE format(
      'ALTER POLICY %I ON %s%s%s',
      policy_row.polname,
      policy_row.polrelid::regclass,
      CASE WHEN using_expression IS NULL THEN ''
        ELSE format(' USING (%s)',using_expression) END,
      CASE WHEN check_expression IS NULL THEN ''
        ELSE format(' WITH CHECK (%s)',check_expression) END
    );
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policy policy
    JOIN pg_class relation ON relation.oid=policy.polrelid
    JOIN pg_namespace schema_row ON schema_row.oid=relation.relnamespace
    WHERE schema_row.nspname='platform'
      AND (COALESCE(pg_get_expr(policy.polqual,policy.polrelid,false),'') LIKE '%platform_worker%'
        OR COALESCE(pg_get_expr(policy.polwithcheck,policy.polrelid,false),'') LIKE '%platform_worker%')
  ) THEN
    RAISE EXCEPTION 'PLATFORM_WORKER_POLICY_FENCE_REMAINS';
  END IF;
END
$split_policy_fences$;

-- SECURITY DEFINER entry points enforce workload kind as well as PostgreSQL role.
DO $split_function_fences$
DECLARE
  function_oid REGPROCEDURE;
  function_definition TEXT;
  replacement_workload TEXT;
BEGIN
  FOREACH function_oid IN ARRAY ARRAY[
    'platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamptz,text)'::regprocedure,
    'platform.apply_admin_authority_change(uuid,jsonb)'::regprocedure
  ]
  LOOP
    replacement_workload := CASE function_oid
      WHEN 'platform.report_model_provider_availability(uuid,text,text,text,bigint,text,timestamp with time zone,text)'::regprocedure
        THEN 'platform_model_gateway'
      WHEN 'platform.apply_admin_authority_change(uuid,jsonb)'::regprocedure
        THEN 'platform_admin_worker'
      ELSE NULL
    END;
    function_definition := pg_get_functiondef(function_oid);
    IF replacement_workload IS NULL OR position('''platform_worker''' IN function_definition)=0 THEN
      RAISE EXCEPTION 'PLATFORM_WORKER_FUNCTION_FENCE_NOT_FOUND:%',function_oid;
    END IF;
    EXECUTE replace(
      function_definition,
      '''platform_worker''',
      quote_literal(replacement_workload)
    );
  END LOOP;
END
$split_function_fences$;

REVOKE ALL ON FUNCTION platform.report_model_provider_availability(
  UUID,TEXT,TEXT,TEXT,BIGINT,TEXT,TIMESTAMPTZ,TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.apply_admin_authority_change(UUID,JSONB) FROM PUBLIC;
