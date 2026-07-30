export const OUTBOX_OWNER_POLICY_COUNT = 17;

/**
 * Audits every policy on the shared outbox against the migrator-owned
 * canonical catalog snapshot stored on the immutable foundation marker.
 * This deliberately examines all policies, including PUBLIC and policies
 * for other runtime roles; checking only the current role would let an extra
 * broad policy silently widen the table.
 */
export const OUTBOX_POLICY_RUNTIME_ASSERTION_SQL = `(
  jsonb_typeof(foundation_marker."outboxPolicyAuthority")='array'
  AND jsonb_array_length(foundation_marker."outboxPolicyAuthority")=${OUTBOX_OWNER_POLICY_COUNT}
  AND (SELECT count(*) FROM pg_policy policy WHERE policy.polrelid=outbox.oid)
    =${OUTBOX_OWNER_POLICY_COUNT}
  AND NOT EXISTS (
    SELECT 1
    FROM (
      SELECT policy.polname AS policy_name,policy.polcmd::text AS command,
        policy.polpermissive AS permissive,
        cardinality(policy.polroles) AS role_count,
        CASE WHEN cardinality(policy.polroles)=1 THEN policy.polroles[1]::text END AS role_oid,
        pg_get_expr(policy.polqual,policy.polrelid,false) AS using_expression,
        pg_get_expr(policy.polwithcheck,policy.polrelid,false) AS with_check_expression
      FROM pg_policy policy WHERE policy.polrelid=outbox.oid
    ) actual
    FULL OUTER JOIN jsonb_to_recordset(foundation_marker."outboxPolicyAuthority") AS expected(
      policy_name TEXT,command TEXT,permissive BOOLEAN,role_oid TEXT,
      using_expression TEXT,with_check_expression TEXT
    ) USING (policy_name)
    WHERE actual.policy_name IS NULL OR expected.policy_name IS NULL
      OR actual.command IS DISTINCT FROM expected.command
      OR actual.permissive IS DISTINCT FROM TRUE
      OR expected.permissive IS DISTINCT FROM TRUE
      OR actual.permissive IS DISTINCT FROM expected.permissive
      OR actual.role_count IS DISTINCT FROM 1
      OR actual.role_oid IS NULL OR actual.role_oid='0'
      OR actual.role_oid IS DISTINCT FROM expected.role_oid
      OR actual.using_expression IS DISTINCT FROM expected.using_expression
      OR actual.with_check_expression IS DISTINCT FROM expected.with_check_expression
  )
)`;
