export type SplitWorkerRole =
  | "commerce-worker"
  | "site-worker"
  | "asset-worker"
  | "admin-worker"
  | "identity-worker"
  | "authorization-maintenance";

export type RelationPrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export interface RelationAuthority {
  readonly relation: string;
  readonly privilege: RelationPrivilege;
  readonly columns?: readonly string[];
}

export interface CanonicalRelationAuthority {
  readonly relation: string;
  readonly privilege: RelationPrivilege;
  readonly columnName: string | null;
}

export interface ExactWorkerAuthorityRow extends Record<string, unknown> {
  readonly roleAuthorityExact: boolean;
  readonly relationAuthorityExact: boolean;
  readonly routineAuthorityExact: boolean;
  readonly publicRelationAuthorityClosed: boolean;
  readonly publicRoutineAuthorityClosed: boolean;
  readonly sequenceAuthorityClosed: boolean;
}

const OUTBOX_UPDATE_COLUMNS = [
  "state",
  "available_at",
  "last_error_code",
  "lease_owner",
  "lease_token",
  "lease_expires_at",
  "attempt",
  "delivered_at",
  "consumer_delivery_id",
  "consumer_acknowledged_at",
  "updated_at",
] as const;

const ASSET_RELATIONS = [
  "asset_upload_intent",
  "asset_upload_session",
  "asset_quota_account",
  "asset_quota_reservation",
  "asset_multipart_upload",
  "asset_multipart_part",
  "asset_blob_candidate",
  "asset_cleanup_group",
  "asset_object_cleanup",
  "asset_object_cleanup_receipt",
  "asset_upload_rejection",
  "asset_scan_evaluation",
  "asset_promotion_intent",
  "asset_blob",
  "asset_resource",
  "asset_version",
  "asset_reference",
  "asset_eligibility_projection",
  "asset_promotion_receipt",
] as const;

const entries = (
  privilege: RelationPrivilege,
  relations: readonly string[],
): readonly RelationAuthority[] => relations.map((relation) => ({ relation, privilege }));

const columns = (
  relation: string,
  privilege: RelationPrivilege,
  allowedColumns: readonly string[],
): RelationAuthority => ({ relation, privilege, columns: allowedColumns });

const base = (...relations: readonly string[]): readonly RelationAuthority[] =>
  entries("SELECT", ["platform_foundation", ...relations]);

const outboxConsumer = (allowInsert: boolean): readonly RelationAuthority[] => [
  ...entries("SELECT", ["outbox_event"]),
  ...(allowInsert ? entries("INSERT", ["outbox_event"]) : []),
  columns("outbox_event", "UPDATE", OUTBOX_UPDATE_COLUMNS),
];

export const SPLIT_WORKER_RELATION_AUTHORITY = Object.freeze({
  "commerce-worker": [
    ...base(
      "commerce_redemption",
      "commerce_fulfillment_transaction",
      "credit_budget_operation_receipt",
      "credit_authorization_segment",
    ),
    ...outboxConsumer(false),
  ],
  "site-worker": [
    ...base(
      "site",
      "site_project_binding",
      "site_release",
      "site_deployment_binding",
      "site_activation_attempt",
      "site_deployment_observation",
      "site_traffic_stop_attempt",
      "site_traffic_stop_observation",
      "authorization_site",
      "authorization_site_release",
      "authorization_product_binding",
      "authorization_scoped_stream_state",
      "authorization_scoped_site_cursor",
      "authorization_scoped_event_log",
      "authorization_scoped_snapshot",
      "authorization_product_context",
      "authorization_session_access_grant",
    ),
    ...outboxConsumer(false),
    ...entries("INSERT", [
      "site_deployment_binding",
      "site_deployment_observation",
      "site_traffic_stop_observation",
      "authorization_site",
      "authorization_site_release",
      "authorization_product_binding",
      "authorization_scoped_site_cursor",
      "authorization_scoped_event_log",
    ]),
    columns("site", "UPDATE", [
      "state",
      "active_release_ref",
      "policy_epoch",
      "revocation_epoch",
      "tombstoned_at",
      "updated_at",
    ]),
    columns("site_release", "UPDATE", ["state", "updated_at"]),
    columns("site_deployment_binding", "UPDATE", ["state", "updated_at"]),
    columns("site_activation_attempt", "UPDATE", [
      "state",
      "provider_operation_key",
      "deployment_ref",
      "observed_at",
      "failure_code",
      "updated_at",
    ]),
    columns("site_traffic_stop_attempt", "UPDATE", [
      "state",
      "provider_operation_key",
      "observed_at",
      "failure_code",
      "updated_at",
    ]),
    columns("authorization_site", "UPDATE", [
      "state",
      "security_epoch",
      "policy_epoch",
      "revocation_epoch",
      "updated_at",
    ]),
    columns("authorization_site_release", "UPDATE", ["state", "updated_at"]),
    columns("authorization_product_binding", "UPDATE", [
      "workload_identity_id",
      "deployment_ref",
      "release_ref",
      "environment",
      "region",
      "audience",
      "session_contract_revision",
      "binding_epoch",
      "state",
      "updated_at",
    ]),
    columns("authorization_scoped_stream_state", "UPDATE", ["high_watermark", "updated_at"]),
    columns("authorization_scoped_site_cursor", "UPDATE", ["aggregate_sequence", "updated_at"]),
  ],
  "asset-worker": [
    ...base(...ASSET_RELATIONS),
    ...outboxConsumer(true),
    ...entries("INSERT", ASSET_RELATIONS.slice(6)),
    columns("asset_upload_intent", "UPDATE", ["state", "expected_version", "updated_at"]),
    columns("asset_upload_session", "UPDATE", [
      "capability_epoch",
      "capability_expires_at",
      "completion_requested_at",
      "state",
      "expected_version",
      "updated_at",
    ]),
    columns("asset_quota_account", "UPDATE", [
      "quota_revision_ref",
      "maximum_inflight_bytes",
      "maximum_ready_bytes",
      "reserved_inflight_bytes",
      "quarantine_bytes",
      "ready_asset_bytes",
      "trash_retained_bytes",
      "expected_version",
      "updated_at",
    ]),
    columns("asset_quota_reservation", "UPDATE", ["state", "release_evidence_ref", "updated_at"]),
    columns("asset_blob_candidate", "UPDATE", ["state", "expected_version", "updated_at"]),
    columns("asset_cleanup_group", "UPDATE", [
      "released_bytes",
      "state",
      "expected_version",
      "completed_at",
      "updated_at",
    ]),
    columns("asset_object_cleanup", "UPDATE", [
      "state",
      "expected_version",
      "last_error_code",
      "completed_at",
      "updated_at",
    ]),
    columns("asset_promotion_intent", "UPDATE", [
      "state",
      "expected_version",
      "copied_provider_version_ref",
      "copied_provider_etag_digest",
      "copied_at",
      "cleanup_group_ref",
      "failure_code",
      "updated_at",
    ]),
  ],
  "admin-worker": [
    ...base(
      "admin_operator_authority",
      "admin_operator_site_scope",
      "admin_operator_global_scope_grant",
      "admin_breakglass_grant",
      "admin_approval",
      "admin_post_effect_review",
    ),
    ...outboxConsumer(false),
    columns("admin_approval", "UPDATE", [
      "state",
      "revision",
      "checker_ref",
      "checker_generation",
      "checker_authorization_epoch",
      "checker_decision",
      "checker_reason",
      "result",
      "result_digest",
      "decided_at",
      "terminal_reason",
      "updated_at",
    ]),
    columns("admin_post_effect_review", "UPDATE", [
      "state",
      "revision",
      "reviewer_ref",
      "reviewer_generation",
      "reviewer_authorization_epoch",
      "reviewer_reason",
      "reviewed_at",
      "terminal_reason",
    ]),
  ],
  "identity-worker": [
    ...base("outbox_event"),
    columns("outbox_event", "UPDATE", OUTBOX_UPDATE_COLUMNS),
    columns("identity_verification_transaction", "SELECT", [
      "site_ref",
      "transaction_ref",
      "state",
      "resend_count",
      "expires_at",
    ]),
    columns("identity_verification_delivery", "SELECT", [
      "event_id",
      "site_ref",
      "transaction_ref",
      "credential_revision",
      "state",
    ]),
    columns("identity_verification_delivery", "UPDATE", [
      "state",
      "attempt_count",
      "delivered_at",
      "failed_at",
      "superseded_at",
      "last_error_code",
      "updated_at",
    ]),
    columns("identity_personal_bootstrap", "SELECT", [
      "site_ref",
      "subject_ref",
      "workspace_ref",
      "project_ref",
      "execution_space_ref",
      "execution_namespace",
      "namespace_intent_ref",
    ]),
    columns("identity_execution_space", "SELECT", [
      "site_ref",
      "execution_space_ref",
      "project_ref",
      "execution_namespace",
      "state",
    ]),
    columns("identity_execution_space", "UPDATE", ["state", "updated_at"]),
    columns("identity_namespace_allocation_intent", "SELECT", [
      "intent_ref",
      "event_id",
      "site_ref",
      "execution_space_ref",
      "execution_namespace",
      "state",
    ]),
    columns("identity_namespace_allocation_intent", "UPDATE", [
      "state",
      "attempt_count",
      "last_error_code",
      "updated_at",
    ]),
  ],
  "authorization-maintenance": [
    ...base("authorization_scoped_event_log", "authorization_scoped_snapshot"),
    ...entries("DELETE", ["authorization_scoped_event_log", "authorization_scoped_snapshot"]),
  ],
} as const satisfies Readonly<Record<SplitWorkerRole, readonly RelationAuthority[]>>);

export const SPLIT_WORKER_ROUTINE_AUTHORITY = Object.freeze({
  "commerce-worker": [],
  "site-worker": [],
  "asset-worker": [],
  "admin-worker": ["platform.apply_admin_authority_change(uuid,jsonb)"],
  "identity-worker": [],
  "authorization-maintenance": [],
} as const satisfies Readonly<Record<SplitWorkerRole, readonly string[]>>);

export const SPLIT_WORKER_RLS_AUTHORITY = Object.freeze({
  "site-worker": {
    workloadKind: "platform_site_worker",
    policies: [
      ["site", "site_scope"],
      ["site_activation_attempt", "site_activation_attempt_scope"],
      ["site_deployment_binding", "site_deployment_binding_scope"],
      ["site_deployment_observation", "site_deployment_observation_scope"],
      ["site_effect_approval", "site_effect_approval_scope"],
      ["site_project_binding", "site_project_binding_scope"],
      ["site_release", "site_release_scope"],
      ["site_traffic_stop_attempt", "site_traffic_stop_attempt_scope"],
      ["site_traffic_stop_observation", "site_traffic_stop_observation_scope"],
    ],
  },
  "asset-worker": {
    workloadKind: "platform_asset_worker",
    policies: [
      ["asset_blob", "asset_blob_worker_scope"],
      ["asset_blob_candidate", "asset_blob_candidate_worker_scope"],
      ["asset_cleanup_group", "asset_cleanup_group_worker_scope"],
      ["asset_eligibility_projection", "asset_eligibility_owner_scope"],
      ["asset_object_cleanup", "asset_object_cleanup_worker_scope"],
      ["asset_object_cleanup_receipt", "asset_object_cleanup_receipt_worker_scope"],
      ["asset_promotion_intent", "asset_promotion_intent_worker_scope"],
      ["asset_promotion_receipt", "asset_promotion_receipt_worker_scope"],
      ["asset_quota_account", "asset_quota_account_site_scope"],
      ["asset_quota_reservation", "asset_quota_reservation_site_scope"],
      ["asset_reference", "asset_reference_owner_scope"],
      ["asset_resource", "asset_resource_owner_scope"],
      ["asset_scan_evaluation", "asset_scan_evaluation_worker_scope"],
      ["asset_upload_intent", "asset_upload_intent_site_scope"],
      ["asset_upload_rejection", "asset_upload_rejection_worker_scope"],
      ["asset_upload_session", "asset_upload_session_site_scope"],
      ["asset_version", "asset_version_owner_scope"],
    ],
  },
  "admin-worker": {
    workloadKind: "platform_admin_worker",
    policies: [
      ["admin_approval", "admin_approval_site_control_plane"],
      ["admin_command_decision", "admin_command_decision_insert"],
      ["admin_operator_authority", "admin_operator_authority_control_plane"],
      ["admin_post_effect_review", "admin_post_effect_review_control_plane"],
    ],
  },
} as const);

const utf8Encoder = new TextEncoder();

/** PostgreSQL authority evidence must not depend on host locale or collation. */
export function compareUtf8Bytewise(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function splitWorkerRelationNames(role: SplitWorkerRole): readonly string[] {
  return Object.freeze(
    [...new Set(SPLIT_WORKER_RELATION_AUTHORITY[role].map((authority) => authority.relation))].sort(
      compareUtf8Bytewise,
    ),
  );
}

export function canonicalRelationAuthority(
  role: SplitWorkerRole,
): readonly CanonicalRelationAuthority[] {
  const rows: CanonicalRelationAuthority[] = [];
  for (const authority of SPLIT_WORKER_RELATION_AUTHORITY[role]) {
    if (authority.columns === undefined) {
      rows.push({ relation: authority.relation, privilege: authority.privilege, columnName: null });
      continue;
    }
    for (const columnName of authority.columns) {
      rows.push({ relation: authority.relation, privilege: authority.privilege, columnName });
    }
  }
  return rows.sort(
    (left, right) =>
      compareUtf8Bytewise(left.relation, right.relation) ||
      compareUtf8Bytewise(left.privilege, right.privilege) ||
      compareUtf8Bytewise(left.columnName ?? "", right.columnName ?? ""),
  );
}

export const SPLIT_WORKER_EXACT_AUTHORITY_SQL = `
  WITH target_role AS (
    SELECT * FROM pg_roles WHERE rolname=$1
  ), expected AS (
    SELECT expected_row.relation,expected_row.privilege,expected_row."columnName"
    FROM jsonb_to_recordset($2::jsonb) AS expected_row(
      relation TEXT,privilege TEXT,"columnName" TEXT
    )
  ), actual AS (
    SELECT relation.relname AS relation,acl.privilege_type AS privilege,
      NULL::TEXT AS "columnName"
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl,acldefault('r',relation.relowner)
    )) acl
    WHERE namespace.nspname='platform' AND relation.relkind=ANY(ARRAY['r','p','v','m','f'])
      AND acl.grantee=(SELECT oid FROM target_role)
    UNION ALL
    SELECT relation.relname,acl.privilege_type,attribute.attname
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid=attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE namespace.nspname='platform' AND relation.relkind=ANY(ARRAY['r','p','v','m','f'])
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND acl.grantee=(SELECT oid FROM target_role)
  )
  SELECT EXISTS (
    SELECT 1 FROM target_role runtime_role
    JOIN pg_database database_row ON database_row.datname=current_database()
    WHERE runtime_role.rolcanlogin
      AND NOT runtime_role.rolinherit
      AND NOT runtime_role.rolsuper
      AND NOT runtime_role.rolcreatedb
      AND NOT runtime_role.rolcreaterole
      AND NOT runtime_role.rolreplication
      AND NOT runtime_role.rolbypassrls
      AND NOT has_database_privilege($1,current_database(),'CREATE')
      AND NOT has_database_privilege($1,current_database(),'TEMPORARY')
      AND database_row.datdba<>runtime_role.oid
      AND NOT EXISTS (
        SELECT 1 FROM pg_auth_members membership
        WHERE membership.member=runtime_role.oid OR membership.roleid=runtime_role.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_namespace namespace WHERE namespace.nspowner=runtime_role.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_class relation WHERE relation.relowner=runtime_role.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_proc routine WHERE routine.proowner=runtime_role.oid
      )
  ) AS "roleAuthorityExact",
  NOT EXISTS (
    (SELECT relation,privilege,"columnName" FROM actual
     EXCEPT SELECT relation,privilege,"columnName" FROM expected)
    UNION ALL
    (SELECT relation,privilege,"columnName" FROM expected
     EXCEPT SELECT relation,privilege,"columnName" FROM actual)
  ) AS "relationAuthorityExact",
  NOT EXISTS (
    SELECT 1 FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    WHERE namespace.nspname='platform' AND has_function_privilege($1,routine.oid,'EXECUTE')
      AND routine.oid<>ALL(COALESCE(
        ARRAY(SELECT to_regprocedure(signature) FROM unnest($3::TEXT[]) signature),
        ARRAY[]::REGPROCEDURE[]
      ))
  ) AND NOT EXISTS (
    SELECT 1 FROM unnest($3::TEXT[]) signature
    WHERE to_regprocedure(signature) IS NULL
      OR NOT has_function_privilege($1,to_regprocedure(signature),'EXECUTE')
  ) AS "routineAuthorityExact",
  NOT EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      relation.relacl,acldefault('r',relation.relowner)
    )) acl
    WHERE namespace.nspname='platform' AND relation.relkind=ANY(ARRAY['r','p','v','m','f'])
      AND acl.grantee=0
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid=attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) acl
    WHERE namespace.nspname='platform' AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND acl.grantee=0
  ) AS "publicRelationAuthorityClosed",
  NOT EXISTS (
    SELECT 1 FROM pg_proc routine
    JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(
      routine.proacl,acldefault('f',routine.proowner)
    )) acl
    WHERE namespace.nspname='platform' AND acl.grantee=0
      AND acl.privilege_type='EXECUTE'
  ) AS "publicRoutineAuthorityClosed",
  NOT EXISTS (
    SELECT 1 FROM pg_class sequence_row
    JOIN pg_namespace namespace ON namespace.oid=sequence_row.relnamespace
    WHERE namespace.nspname='platform'
      AND CASE WHEN sequence_row.relkind='S' THEN
        has_sequence_privilege($1,sequence_row.oid,'USAGE,SELECT,UPDATE')
      ELSE FALSE END
  ) AS "sequenceAuthorityClosed"
  /* splitWorkerExactAuthority */
`;
