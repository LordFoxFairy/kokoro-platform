import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlatformDatabaseConfig,
  type PlatformDatabaseClient,
} from "../../src/infrastructure/postgres/client.js";
import {
  MIGRATION_ADVISORY_LOCK,
  runPlatformMigrations,
  type MigrationLockClient,
} from "../../src/infrastructure/postgres/migrator.js";
import {
  SPLIT_WORKER_DEFINER_RLS_AUTHORITY,
  SPLIT_WORKER_RLS_AUTHORITY,
} from
  "../../src/infrastructure/postgres/split-worker-authority.js";
import { createPlatformApiProcess } from "../../src/process/api.js";
import { createPlatformWorkerProcess } from "../../src/process/worker.js";

const apiUrl = "postgresql://platform_api:secret@localhost:5432/kokoro_platform";
const admissionUrl = "postgresql://platform_admission:secret@localhost:5432/kokoro_platform";
const commerceWorkerUrl =
  "postgresql://platform_commerce_worker:secret@localhost:5432/kokoro_platform";
const identityWorkerUrl =
  "postgresql://platform_identity_worker:secret@localhost:5432/kokoro_platform";
const modelImageWorkerUrl =
  "postgresql://platform_model_image_worker:secret@localhost:5432/kokoro_platform";
const memoryPublicUrl =
  "postgresql://platform_memory_public:secret@localhost:5432/kokoro_platform";
const memoryRuntimeUrl =
  "postgresql://platform_memory_runtime:secret@localhost:5432/kokoro_platform";
const memoryWorkerUrl =
  "postgresql://platform_memory_worker:secret@localhost:5432/kokoro_platform";
const authorizationUrl = "postgresql://platform_authorization:secret@localhost:5432/kokoro_platform";
const assetDataPlaneUrl = "postgresql://platform_asset_data_plane:secret@localhost:5432/kokoro_platform";
const adminUrl = "postgresql://platform_admin:secret@localhost:5432/kokoro_platform";
const migratorUrl = "postgresql://platform_migrator:secret@localhost:5432/kokoro_platform";
const commonEnvironment = {
  PLATFORM_DATABASE_EXPECTED_DATABASE: "kokoro_platform",
  PLATFORM_DATABASE_MIGRATOR_ROLE: "platform_migrator",
  PLATFORM_DATABASE_ADMISSION_ROLE: "platform_admission",
  PLATFORM_DATABASE_ADMIN_ROLE: "platform_admin",
  PLATFORM_DATABASE_AUTHORIZATION_ROLE: "platform_authorization",
  PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE: "platform_asset_data_plane",
  PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE: "platform_artifact_data_plane",
  PLATFORM_DATABASE_MODEL_GATEWAY_ROLE: "platform_model_gateway",
  PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: "platform_commerce_worker",
  PLATFORM_DATABASE_SITE_WORKER_ROLE: "platform_site_worker",
  PLATFORM_DATABASE_ASSET_WORKER_ROLE: "platform_asset_worker",
  PLATFORM_DATABASE_ADMIN_WORKER_ROLE: "platform_admin_worker",
  PLATFORM_DATABASE_IDENTITY_WORKER_ROLE: "platform_identity_worker",
  PLATFORM_DATABASE_MODEL_IMAGE_WORKER_ROLE: "platform_model_image_worker",
  PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE: "platform_authorization_maintenance",
  PLATFORM_DATABASE_MEMORY_PUBLIC_ROLE: "platform_memory_public",
  PLATFORM_DATABASE_MEMORY_RUNTIME_ROLE: "platform_memory_runtime",
  PLATFORM_DATABASE_MEMORY_WORKER_ROLE: "platform_memory_worker",
} as const;

describe("Platform PostgreSQL authority", () => {
  it("loads an API-only identity with bounded connection and transaction settings", () => {
    const config = loadPlatformDatabaseConfig("api", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: "platform_api",
    });

    expect(config).toMatchObject({
      role: "api",
      credentialClass: "api",
      expectedDatabaseUser: "platform_api",
      expectedDatabaseName: "kokoro_platform",
      migratorDatabaseUser: "platform_migrator",
      applicationName: "kokoro-platform-api",
      schema: "platform",
      pool: { max: 20, connectionTimeoutMs: 5_000 },
      session: {
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 3_000,
        idleTransactionTimeoutMs: 10_000,
      },
      transaction: { isolationLevel: "ReadCommitted", maxWaitMs: 5_000, timeoutMs: 10_000 },
    });
    expect(config.safeDatabaseIdentity).toBe("localhost:5432/kokoro_platform");
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("requires URL, expected database, and explicit process identity to agree", () => {
    expect(() =>
      loadPlatformDatabaseConfig("commerce-worker", {
        ...commonEnvironment,
        DATABASE_URL_PLATFORM: commerceWorkerUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "commerce-worker",
        PLATFORM_DATABASE_COMMERCE_WORKER_ROLE: "unexpected_worker",
      }),
    ).toThrowError("PLATFORM_DATABASE_URL_USER_MISMATCH");
  });

  it("keeps every runtime and migrator credential class independent", () => {
    const api = loadPlatformDatabaseConfig("api", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: apiUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "api",
      PLATFORM_DATABASE_API_ROLE: "platform_api",
    });
    const commerceWorker = loadPlatformDatabaseConfig("commerce-worker", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: commerceWorkerUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "commerce-worker",
    });
    const identityWorker = loadPlatformDatabaseConfig("identity-worker", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: identityWorkerUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "identity-worker",
    });
    const modelImageWorker = loadPlatformDatabaseConfig("model-image-worker", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: modelImageWorkerUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "model-image-worker",
    });
    const memoryPublic = loadPlatformDatabaseConfig("memory-public", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: memoryPublicUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "memory-public",
    });
    const memoryRuntime = loadPlatformDatabaseConfig("memory-runtime", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: memoryRuntimeUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "memory-runtime",
    });
    const memoryWorker = loadPlatformDatabaseConfig("memory-worker", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: memoryWorkerUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "memory-worker",
    });
    const admission = loadPlatformDatabaseConfig("admission", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: admissionUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admission",
    });
    const authorization = loadPlatformDatabaseConfig("authorization", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: authorizationUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "authorization",
    });
    const assetDataPlane = loadPlatformDatabaseConfig("asset-data-plane", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: assetDataPlaneUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "asset-data-plane",
    });
    const admin = loadPlatformDatabaseConfig("admin", {
      ...commonEnvironment,
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
    });
    expect(
      new Set([
        api.expectedDatabaseUser,
        admission.expectedDatabaseUser,
        commerceWorker.expectedDatabaseUser,
        identityWorker.expectedDatabaseUser,
        modelImageWorker.expectedDatabaseUser,
        authorization.expectedDatabaseUser,
        assetDataPlane.expectedDatabaseUser,
        admin.expectedDatabaseUser,
        memoryPublic.expectedDatabaseUser,
        memoryRuntime.expectedDatabaseUser,
        memoryWorker.expectedDatabaseUser,
        api.migratorDatabaseUser,
      ]).size,
    ).toBe(12);
    expect(admission).toMatchObject({
      role: "admission",
      credentialClass: "admission",
      expectedDatabaseUser: "platform_admission",
      applicationName: "kokoro-platform-admission",
      pool: { max: 12, connectionTimeoutMs: 5_000 },
    });
    expect(identityWorker).toMatchObject({
      role: "identity-worker",
      credentialClass: "identity-worker",
      expectedDatabaseUser: "platform_identity_worker",
      applicationName: "kokoro-platform-identity-worker",
      pool: { max: 4, connectionTimeoutMs: 5_000 },
    });
    expect(modelImageWorker).toMatchObject({
      role: "model-image-worker",
      credentialClass: "model-image-worker",
      expectedDatabaseUser: "platform_model_image_worker",
      applicationName: "kokoro-platform-model-image-worker",
      pool: { max: 8, connectionTimeoutMs: 5_000 },
    });
    expect([memoryPublic, memoryRuntime, memoryWorker]).toMatchObject([
      { role: "memory-public", credentialClass: "memory-public",
        expectedDatabaseUser: "platform_memory_public" },
      { role: "memory-runtime", credentialClass: "memory-runtime",
        expectedDatabaseUser: "platform_memory_runtime" },
      { role: "memory-worker", credentialClass: "memory-worker",
        expectedDatabaseUser: "platform_memory_worker" },
    ]);
    expect(JSON.stringify([memoryPublic, memoryRuntime, memoryWorker])).not.toContain("secret");
  });
});

describe("Platform migrator", () => {
  it("preflights PostgreSQL 18 roles, locks migration, grants scoped access, and sanitizes env", async () => {
    const events: string[] = [];
    const grants: string[] = [];
    let authoritySql = "";
    let memoryAuthoritySql = "";
    const lockClient: MigrationLockClient = {
      async connect() {
        events.push("connect");
      },
      async query(sql, values) {
        if (sql.includes("memoryRolePreflight")) {
          events.push("preflight-memory-roles");
          return { rows: safeMemoryRoles() };
        }
        if (sql.includes("singleRuntimeRolePreflight")) {
          const roleName = String(values?.[0]);
          events.push(`preflight-${roleName.replace("platform_", "").replaceAll("_", "-")}`);
          return { rows: [safeRole(roleName)] };
        }
        if (sql.includes("modelGatewayAuthority")) {
          events.push("verify-model-gateway");
          return { rows: [{
            modelGatewayAuthorityOk: true,
            canReadAuthorizationProjection: false,
          }] };
        }
        if (sql.includes("assetDataPlaneAuthority")) {
          events.push("verify-asset-data-plane");
          return { rows: [{
            assetDataPlaneAuthorityOk: true,
            completionFunctionAuthorityOk: true,
            canReadGenericOutbox: false,
            canMutateAssetOwnerIntent: false,
          }] };
        }
        if (sql.includes("artifactDataPlaneAuthority")) {
          events.push("verify-artifact-data-plane");
          return { rows: [{ artifactDataPlaneAuthorityOk: true }] };
        }
        if (sql.includes("identityWorkerAuthority")) {
          events.push("verify-identity-worker");
          return { rows: [{
            identityWorkerAuthorityOk: true,
            hasUnexpectedIdentityPrivilege: false,
          }] };
        }
        if (sql.includes("splitWorkerExactAuthority")) {
          const roleName = String(values?.[0]);
          events.push(`verify-${roleName}`);
          return { rows: [splitAuthority()] };
        }
        if (sql.includes('AS "roleIdentityAuthorityExact"')) {
          events.push("verify-split-worker-role-identities");
          return { rows: [{ roleIdentityAuthorityExact: true }] };
        }
        if (sql.includes("memoryRoleAuthority")) {
          events.push("verify-memory-role-authority");
          memoryAuthoritySql = sql;
          return { rows: [{ memoryRoleAuthorityExact: true }] };
        }
        if (sql.includes("publicRoutineAuthorityClosed")) {
          return { rows: [{ publicRoutineAuthorityClosed: true }] };
        }
        if (sql.includes("server_version_num")) {
          events.push("preflight-migrator");
          return {
            rows: [
              {
                serverMajor: 18,
                currentUser: "platform_migrator",
                currentDatabase: "kokoro_platform",
                databaseOwner: "platform_migrator",
                isSuperuser: false,
                canCreateDatabase: false,
                canCreateRole: false,
                canReplicate: false,
                canBypassRls: false,
                inheritsPrivileges: false,
                hasAnyMembership: false,
                isApiMember: false,
                isAdmissionMember: false,
                isAuthorizationMember: false,
                isWorkerMember: false,
                isAdminMember: false,
                canCreateDatabaseObject: true,
                schemaExists: false,
                schemaOwner: null,
                publicCanUseSchema: false,
                publicCanCreateSchema: false,
              },
            ],
          };
        }
        if (sql.includes("isMigratorMember")) {
          events.push("preflight-runtime-roles");
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_admission"),
              safeRole("platform_authorization"),
              safeRole("platform_admin"),
            ],
          };
        }
        if (sql.includes("canReadFoundation")) {
          events.push("verify-authority");
          authoritySql = sql;
          return {
            rows: [
              authority("platform_api"),
              authority("platform_admission"),
              authority("platform_authorization"),
              authority("platform_admin"),
            ],
          };
        }
        if (sql.includes("splitWorkerPolicyLookup")) {
          return { rows: [splitWorkerPolicyLookup(values)] };
        }
        if (sql.includes("splitWorkerPolicyCatalog")) {
          return { rows: splitWorkerPolicyRows() };
        }
        if (sql.includes("FROM pg_policy policy")) {
          events.push("verify-outbox-policies");
          return { rows: outboxPolicyRows() };
        }
        if (sql.includes('SET "outboxPolicyAuthority"')) {
          events.push("persist-outbox-policy-authority");
          return { rows: [{ singleton: true }] };
        }
        if (/^(?:REVOKE|GRANT|ALTER DEFAULT PRIVILEGES)/u.test(sql)) {
          events.push("grant");
          grants.push(sql);
          return {};
        }
        events.push(`${sql}:${values?.join(",") ?? ""}`);
        return {};
      },
      async end() {
        events.push("end");
      },
    };

    await runPlatformMigrations({
      environment: {
        ...commonEnvironment,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
        PLATFORM_DATABASE_API_ROLE: "platform_api",
        PATH: "/usr/bin",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
        SITE_PROVIDER_SECRET: "must-not-leak",
      },
      createLockClient: () => lockClient,
      execute: async (command, args, environment) => {
        events.push("execute");
        expect(command).toBe(process.execPath);
        expect(args).toContain(resolve("dist/prisma.config.js"));
        expect(environment.DATABASE_URL_PLATFORM).toBe(migratorUrl);
        expect(environment.PATH).toBe("/usr/bin");
        expect(environment.NODE_OPTIONS).toBeUndefined();
        expect(environment.SITE_PROVIDER_SECRET).toBeUndefined();
        return 0;
      },
    });

    expect(events.slice(0, 14)).toEqual([
      "connect",
      "preflight-migrator",
      "preflight-runtime-roles",
      "preflight-model-gateway",
      "preflight-asset-data-plane",
      "preflight-artifact-data-plane",
      "preflight-commerce-worker",
      "preflight-site-worker",
      "preflight-asset-worker",
      "preflight-admin-worker",
      "preflight-identity-worker",
      "preflight-authorization-maintenance",
      "preflight-memory-roles",
      `SELECT pg_advisory_lock(hashtext($1)):${MIGRATION_ADVISORY_LOCK}`,
    ]);
    expect(events[14]).toBe("execute");
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.resolve_admission_model_owner(TEXT, TEXT, TEXT) TO \"platform_admission\"",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION platform.resolve_model_gateway_authorization(TEXT,TEXT) TO \"platform_model_gateway\"",
    );
    expect(grants).toContain(
      "GRANT INSERT ON TABLE platform.model_gateway_execution_authorization TO \"platform_admission\"",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION platform.enqueue_asset_upload_completion_event(UUID,TEXT,JSONB,CHAR(64),TEXT,TEXT) TO \"platform_asset_data_plane\"",
    );
    expect(grants).toContain(
      "REVOKE ALL ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.commerce_safe_label_is_valid(TEXT), platform.commerce_iana_zone_is_valid(TEXT), platform.import_model_inventory(UUID, TEXT, TEXT, JSONB, JSONB, TEXT), platform.activate_model_inventory(UUID, TEXT, BIGINT, TEXT), platform.put_model_site_policy(UUID, TEXT, TEXT, TEXT, BIGINT), platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID), platform.report_model_provider_availability(UUID, TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ, TEXT), platform.load_model_option_inventory(TEXT), platform.load_model_option_revisions(TEXT[]), platform.materialize_model_options(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT), platform.publish_site_release_model_catalog(UUID, JSONB, TEXT), platform.resolve_product_model_option_catalog(TEXT, TEXT), platform.resolve_admission_model_owner(TEXT, TEXT, TEXT) FROM \"platform_api\"",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.commerce_safe_label_is_valid(TEXT), platform.resolve_model_candidates(TEXT, TEXT, TEXT), platform.find_model_selection_decision(UUID), platform.resolve_product_model_option_catalog(TEXT, TEXT) TO \"platform_api\"",
    );
    expect(grants).toContain(
      "GRANT EXECUTE ON FUNCTION platform.valid_credit_scope_policy(JSONB), platform.commerce_safe_label_is_valid(TEXT), platform.commerce_iana_zone_is_valid(TEXT) TO \"platform_admin\"",
    );
    const apiGrants = grants.filter((sql) => sql.endsWith('TO "platform_api"'));
    expect(apiGrants.some((sql) => sql.includes("platform.commerce_catalog_epoch_authority"))).toBe(false);
    expect(grants).toContain(
      "GRANT SELECT ON TABLE platform.commerce_catalog_epoch_authority TO \"platform_admin\"",
    );
    expect(grants.some((sql) =>
      sql.startsWith("GRANT UPDATE ON TABLE platform.commerce_catalog_epoch_authority") &&
      sql.endsWith('TO "platform_admin"'),
    )).toBe(true);
    expect(grants.some((sql) =>
      sql.startsWith("GRANT INSERT ON TABLE platform.admission_command") &&
      sql.endsWith('TO "platform_admission"'),
    )).toBe(true);
    expect(grants.some((sql) =>
      sql.includes("platform.admission_command") &&
      sql.startsWith("GRANT INSERT") &&
      sql.endsWith('TO "platform_api"'),
    )).toBe(false);
    for (const workerRole of [
      "platform_commerce_worker",
      "platform_site_worker",
      "platform_asset_worker",
      "platform_admin_worker",
      "platform_authorization_maintenance",
    ]) {
      expect(grants.filter((sql) =>
        sql.endsWith(`TO "${workerRole}"`) && sql.includes("platform.identity_"),
      )).toEqual([]);
    }
    expect(grants.some((sql) =>
      sql.endsWith('TO "platform_identity_worker"') &&
      sql.includes("platform.identity_verification_transaction"),
    )).toBe(true);
    const columnInsertAuthority = authoritySql.match(
      /has_any_column_privilege\(runtime_role\.rolname, candidate\.oid, 'INSERT'\)[\s\S]*?(?=OR \(has_any_column_privilege\(runtime_role\.rolname, candidate\.oid, 'UPDATE'\))/u,
    )?.[0];
    const columnUpdateAuthority = authoritySql.match(
      /has_any_column_privilege\(runtime_role\.rolname, candidate\.oid, 'UPDATE'\)[\s\S]*?(?=OR \(candidate\.relname = 'platform_foundation')/u,
    )?.[0];
    expect(columnInsertAuthority).toContain("runtime_role.rolname = $5");
    expect(columnInsertAuthority).toContain("'admission_command'");
    expect(columnInsertAuthority).toContain("'admission_media_access_authorization'");
    expect(columnUpdateAuthority).toContain("runtime_role.rolname = $5");
    expect(columnUpdateAuthority).toContain("'admission_execution_manifest'");
    expect(columnUpdateAuthority).toContain("'admission_media_access_authorization'");
    const admissionSelectFence = authoritySql.match(
      /runtime_role\.rolname=\$5 AND \([\s\S]*?'SELECT'[\s\S]*?candidate\.relname <> ALL\(ARRAY\[[\s\S]*?'credit_authorization_segment'[\s\S]*?\]\)\)/u,
    )?.[0];
    expect(admissionSelectFence).toContain("'authorization_session_access_grant'");
    expect(admissionSelectFence).toContain("'asset_eligibility_projection'");
    expect(admissionSelectFence).toContain("'admission_media_access_authorization'");
    const relationInventories = [
      authoritySql.match(/candidate\.relname <> ALL\(ARRAY\[([\s\S]*?)\]\) AND/u)?.[1],
      authoritySql.match(/candidate\.relname = ANY\(ARRAY\[([\s\S]*?)\]\) AND \(/u)?.[1],
    ];
    expect(relationInventories).not.toContain(undefined);
    expect(relationInventories.every((inventory) =>
      inventory?.includes("'commerce_catalog_epoch_authority'") === true,
    )).toBe(true);
    for (const mediaRelation of [
      "'admission_media_access_authorization'",
      "'media_operation_definition_revision'",
      "'site_release_media_definition'",
    ]) {
      expect(relationInventories.every((inventory) =>
        inventory?.includes(mediaRelation) === true,
      )).toBe(true);
    }
    const adminRelationAllowlists = [...authoritySql.matchAll(
      /runtime_role\.rolname = \$4\s+AND candidate\.relname = ANY\(ARRAY\[([\s\S]*?)\]\)\)/gu,
    )].map((match) => match[1]);
    expect(adminRelationAllowlists.filter((allowlist) =>
      allowlist?.includes("'commerce_catalog_epoch_authority'") === true,
    )).toHaveLength(2);
    expect(adminRelationAllowlists.filter((allowlist) =>
      allowlist?.includes("'site_release_media_definition'") === true,
    )).toHaveLength(2);
    const mediaAdminSelectFence = authoritySql.match(
      /candidate\.relname = ANY\(ARRAY\[[^\]]*'media_operation_definition_revision'[^\]]*\]\)\s+AND runtime_role\.rolname <> \$4/u,
    )?.[0];
    expect(mediaAdminSelectFence).toContain("'site_release_media_definition'");
    expect(authoritySql).toContain('AS "canReadCommerceCatalogEpoch"');
    expect(authoritySql).toContain('AS "canUpdateCommerceCatalogEpoch"');
    expect(authoritySql).toMatch(
      /runtime_role\.rolname=\$3 AND \([\s\S]+grant_row\.table_name LIKE 'identity\\_%'/u,
    );
    for (const requiredEvidence of [
      "has_database_privilege", "'CREATE'", "'TEMPORARY'", "nspname='public'",
      "relkind='S'", "pg_default_acl", "defaclrole",
    ]) expect(memoryAuthoritySql).toContain(requiredEvidence);
    for (const expected of [
      "verify-outbox-policies", "persist-outbox-policy-authority", "verify-authority",
      "verify-model-gateway", "verify-asset-data-plane", "verify-platform_commerce_worker",
      "verify-platform_site_worker", "verify-platform_asset_worker",
      "verify-platform_admin_worker", "verify-platform_identity_worker",
      "verify-platform_authorization_maintenance",
      "verify-split-worker-role-identities",
      "verify-memory-role-authority",
    ]) expect(events).toContain(expected);
    expect(events.slice(-2)).toEqual([
      `SELECT pg_advisory_unlock(hashtext($1)):${MIGRATION_ADVISORY_LOCK}`, "end",
    ]);
  });

  it.each([
    ["belongs to an upstream database role", "hasAnyMembership"],
    ["has a downstream database-role member", "isPeerMember"],
    ["owns a PostgreSQL database", "ownsAnyDatabase"],
  ] as const)("fails closed when a runtime role %s", async (_description, membershipField) => {
    const lockClient: MigrationLockClient = {
      async connect() {},
      async query(sql) {
        if (sql.includes("assetDataPlaneRolePreflight")) {
          return { rows: [safeRole("platform_asset_data_plane")] };
        }
        if (sql.includes("identityWorkerRolePreflight")) {
          return { rows: [safeRole("platform_identity_worker")] };
        }
        if (sql.includes("server_version_num")) {
          return { rows: [safeMigratorAuthority()] };
        }
        if (sql.includes("hasAnyMembership") || sql.includes("isMigratorMember")) {
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_admission"),
              safeRole("platform_authorization"),
              { ...safeRole("platform_worker"), [membershipField]: true },
              safeRole("platform_admin"),
            ],
          };
        }
        return {};
      },
      async end() {},
    };

    await expect(
      runPlatformMigrations({
        environment: migratorEnvironment(),
        createLockClient: () => lockClient,
        execute: async () => 0,
      }),
    ).rejects.toThrowError("PLATFORM_RUNTIME_ROLE_PREFLIGHT_FAILED");
  });

  it("fails before migration when a Memory login owns a PostgreSQL object", async () => {
    let executed = false;
    const lockClient: MigrationLockClient = {
      async connect() {},
      async query(sql, values) {
        if (sql.includes("server_version_num")) return { rows: [safeMigratorAuthority()] };
        if (sql.includes("singleRuntimeRolePreflight")) {
          return { rows: [safeRole(String(values?.[0]))] };
        }
        if (sql.includes("isMigratorMember") && !sql.includes("memoryRolePreflight")) {
          return { rows: [
            safeRole("platform_api"), safeRole("platform_admission"),
            safeRole("platform_authorization"), safeRole("platform_admin"),
          ] };
        }
        if (sql.includes("memoryRolePreflight")) {
          return { rows: safeMemoryRoles().map((role) =>
            role.roleName === "platform_memory_worker"
              ? { ...role, ownsAnySequence: true }
              : role) };
        }
        return {};
      },
      async end() {},
    };

    await expect(runPlatformMigrations({
      environment: migratorEnvironment(),
      createLockClient: () => lockClient,
      execute: async () => { executed = true; return 0; },
    })).rejects.toThrowError("PLATFORM_MEMORY_ROLE_PREFLIGHT_FAILED");
    expect(executed).toBe(false);
  });

  it("fails closed when a runtime role can access any Platform object beyond marker SELECT", async () => {
    const lockClient: MigrationLockClient = {
      async connect() {},
      async query(sql, values) {
        if (sql.includes("memoryRolePreflight")) {
          return { rows: safeMemoryRoles() };
        }
        if (sql.includes("singleRuntimeRolePreflight")) {
          return { rows: [safeRole(String(values?.[0]))] };
        }
        if (sql.includes("assetDataPlaneAuthority")) {
          return { rows: [{
            assetDataPlaneAuthorityOk: true,
            completionFunctionAuthorityOk: true,
            canReadGenericOutbox: false,
            canMutateAssetOwnerIntent: false,
          }] };
        }
        if (sql.includes("identityWorkerAuthority")) {
          return { rows: [{
            identityWorkerAuthorityOk: true,
            hasUnexpectedIdentityPrivilege: false,
          }] };
        }
        if (sql.includes("server_version_num")) return { rows: [safeMigratorAuthority()] };
        if (sql.includes("hasAnyMembership") || sql.includes("isMigratorMember")) {
          return {
            rows: [
              safeRole("platform_api"),
              safeRole("platform_admission"),
              safeRole("platform_authorization"),
              safeRole("platform_admin"),
            ],
          };
        }
        if (sql.includes("splitWorkerPolicyLookup")) {
          return { rows: [splitWorkerPolicyLookup(values)] };
        }
        if (sql.includes("splitWorkerPolicyCatalog")) {
          return { rows: splitWorkerPolicyRows() };
        }
        if (sql.includes("splitWorkerExactAuthority")) return { rows: [splitAuthority()] };
        if (sql.includes("FROM pg_policy policy")) return { rows: outboxPolicyRows() };
        if (sql.includes('SET "outboxPolicyAuthority"')) {
          return { rows: [{ singleton: true }] };
        }
        if (sql.includes("memoryRoleAuthority")) {
          return { rows: [{ memoryRoleAuthorityExact: true }] };
        }
        if (sql.includes("hasUnexpectedPlatformPrivilege")) {
          return {
            rows: [
              { ...authority("platform_api"), hasUnexpectedPlatformPrivilege: true },
              authority("platform_admission"),
              authority("platform_authorization"),
              authority("platform_admin"),
            ],
          };
        }
        return {};
      },
      async end() {},
    };

    await expect(
      runPlatformMigrations({
        environment: migratorEnvironment(),
        createLockClient: () => lockClient,
        execute: async () => 0,
      }),
    ).rejects.toThrowError("PLATFORM_POST_MIGRATION_AUTHORITY_INVALID");
  });

  it.each([
    ["platform_api", "canReadCommerceCatalogEpoch", true],
    ["platform_api", "canUpdateCommerceCatalogEpoch", true],
    ["platform_admin", "canReadCommerceCatalogEpoch", false],
    ["platform_admin", "canUpdateCommerceCatalogEpoch", false],
  ] as const)("fails closed when %s has the wrong catalog epoch authority (%s)",
    async (roleName, field, value) => {
      const lockClient: MigrationLockClient = {
        async connect() {},
        async query(sql, values) {
          if (sql.includes("memoryRolePreflight")) {
            return { rows: safeMemoryRoles() };
          }
          if (sql.includes("singleRuntimeRolePreflight")) {
            return { rows: [safeRole(String(values?.[0]))] };
          }
          if (sql.includes("identityWorkerAuthority")) {
            return { rows: [{
              identityWorkerAuthorityOk: true,
              hasUnexpectedIdentityPrivilege: false,
            }] };
          }
          if (sql.includes("server_version_num")) return { rows: [safeMigratorAuthority()] };
          if (sql.includes("hasAnyMembership") || sql.includes("isMigratorMember")) {
            return { rows: [
              safeRole("platform_api"), safeRole("platform_admission"),
              safeRole("platform_authorization"),
              safeRole("platform_admin"),
            ] };
          }
          if (sql.includes("splitWorkerPolicyLookup")) {
            return { rows: [splitWorkerPolicyLookup(values)] };
          }
          if (sql.includes("splitWorkerPolicyCatalog")) {
            return { rows: splitWorkerPolicyRows() };
          }
          if (sql.includes("splitWorkerExactAuthority")) return { rows: [splitAuthority()] };
          if (sql.includes("FROM pg_policy policy")) return { rows: outboxPolicyRows() };
          if (sql.includes('SET "outboxPolicyAuthority"')) {
            return { rows: [{ singleton: true }] };
          }
          if (sql.includes("memoryRoleAuthority")) {
            return { rows: [{ memoryRoleAuthorityExact: true }] };
          }
          if (sql.includes("hasUnexpectedPlatformPrivilege")) {
            return { rows: [
              authority("platform_api"), authority("platform_admission"),
              authority("platform_authorization"),
              authority("platform_admin"),
            ].map((row) => row.roleName === roleName ? { ...row, [field]: value } : row) };
          }
          return {};
        },
        async end() {},
      };

      await expect(runPlatformMigrations({
        environment: migratorEnvironment(),
        createLockClient: () => lockClient,
        execute: async () => 0,
      })).rejects.toThrowError(new RegExp(
        `PLATFORM_POST_MIGRATION_AUTHORITY_INVALID:.*${field}`,
        "u",
      ));
    });
});

describe("independent deployable roles", () => {
  it("serializes API start/drain and returns to stopped", async () => {
    const calls: string[] = [];
    const process = createPlatformApiProcess({ database: fakeDatabase(calls) });
    await process.start({ host: "127.0.0.1", port: 0 });
    const healthAddress = process.healthAddress();
    expect(healthAddress).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(process.status()).toEqual({
      state: "running",
      live: true,
      ready: true,
      draining: false,
    });
    expect(await fetch(`${healthAddress}/health/ready`).then((response) => response.status)).toBe(200);
    await process.shutdown();
    expect(process.status()).toEqual({
      state: "stopped",
      live: false,
      ready: false,
      draining: false,
    });
    expect(calls).toEqual(["connect", "health", "health", "disconnect"]);
  });

  it("serves probes only on the dedicated health listener", async () => {
    const publicRequests: string[] = [];
    let healthChecks = 0;
    const process = createPlatformApiProcess({
      database: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        checkHealth: async () => { healthChecks += 1; },
      },
      publicHttp: {
        handle: async (request) => {
          publicRequests.push(request.url ?? "");
          return false;
        },
      },
    });
    const publicAddress = await process.start(
      { host: "127.0.0.1", port: 0 },
      { host: "127.0.0.1", port: 0 },
    );
    const healthAddress = process.healthAddress();

    try {
      expect(await fetch(`${publicAddress}/health/live`).then((response) => response.status))
        .toBe(404);
      expect(await fetch(`${publicAddress}/health/ready`).then((response) => response.status))
        .toBe(404);
      expect(publicRequests).toEqual(["/health/live", "/health/ready"]);
      expect(healthChecks).toBe(1);
      expect(await fetch(`${healthAddress}/health/live`).then((response) => response.status))
        .toBe(200);
      expect(await fetch(`${healthAddress}/health/ready`).then((response) => response.status))
        .toBe(200);
      expect(healthChecks).toBe(2);
    } finally {
      await process.shutdown();
    }
  });

  it("lets API readiness recover after a transient database failure", async () => {
    let databaseAvailable = true;
    const database: PlatformDatabaseClient = {
      connect: async () => undefined,
      disconnect: async () => undefined,
      checkHealth: async () => {
        if (!databaseAvailable) throw new Error("database down");
      },
    };
    const process = createPlatformApiProcess({ database });
    await process.start({ host: "127.0.0.1", port: 0 });
    const healthAddress = process.healthAddress();
    databaseAvailable = false;
    expect(await fetch(`${healthAddress}/health/ready`).then((response) => response.status)).toBe(503);
    expect(process.status().ready).toBe(false);
    databaseAvailable = true;
    expect(await fetch(`${healthAddress}/health/ready`).then((response) => response.status)).toBe(200);
    expect(process.status().ready).toBe(true);
    await process.shutdown();
  });

  it("stops claims, aborts an in-flight cycle, and drains Worker", async () => {
    const calls: string[] = [];
    const worker = createPlatformWorkerProcess({
      database: fakeDatabase(calls),
      pollIntervalMs: 60_000,
      stopClaiming: async () => {
        calls.push("stop-claim");
      },
      returnLease: async (reason) => {
        calls.push(`return:${reason}`);
      },
      runOneCycle: ({ signal }) =>
        new Promise<void>((resolveCycle) => {
          calls.push("cycle");
          signal.addEventListener("abort", () => resolveCycle(), { once: true });
        }),
    });
    await worker.start();
    await worker.shutdown({ deadlineMs: 500 });
    expect(worker.status()).toEqual({
      state: "stopped",
      live: false,
      ready: false,
      draining: false,
    });
    expect(calls).toEqual([
      "connect",
      "health",
      "cycle",
      "stop-claim",
      "return:shutdown",
      "disconnect",
    ]);
  });

  it("returns a lease instead of waiting forever past the Worker deadline", async () => {
    const calls: string[] = [];
    const worker = createPlatformWorkerProcess({
      database: fakeDatabase(calls),
      runOneCycle: async () => new Promise<void>(() => undefined),
      returnLease: async (reason) => {
        calls.push(`return:${reason}`);
      },
    });
    await worker.start();
    await expect(worker.shutdown({ deadlineMs: 10 })).rejects.toThrowError(
      "PLATFORM_WORKER_SHUTDOWN_UNCONFIRMED",
    );
    expect(calls).toContain("return:shutdown-deadline");
    expect(worker.status().state).toBe("failed");
    await expect(worker.start()).rejects.toThrowError(
      "PLATFORM_WORKER_RESTART_REQUIRES_PROCESS_REPLACEMENT",
    );
  });

  it("fails API shutdown when the single drain deadline cannot stop startup", async () => {
    const database: PlatformDatabaseClient = {
      connect: async () => new Promise<void>(() => undefined),
      disconnect: async () => undefined,
      checkHealth: async () => undefined,
    };
    const process = createPlatformApiProcess({ database });
    void process.start({ host: "127.0.0.1", port: 0 }).catch(() => undefined);

    await expect(process.shutdown({ deadlineMs: 10 })).rejects.toThrowError(
      "PLATFORM_API_SHUTDOWN_UNCONFIRMED",
    );
    expect(process.status()).toEqual({
      state: "failed",
      live: false,
      ready: false,
      draining: false,
    });
  }, 100);

  it("publishes executable image selectors and distinct database roles", async () => {
    const manifest = await readFile(resolve("deployables.yaml"), "utf8");
    const entrypoint = await readFile(resolve("deploy/docker/runtime-entrypoint.mjs"), "utf8");
    for (const role of ["platform-api", "platform-admission", "platform-authorization", "platform-asset-data-plane", "platform-model-gateway", "platform-commerce-worker", "platform-site-worker", "platform-asset-worker", "platform-admin-worker", "platform-identity-worker", "platform-model-image-worker", "platform-authorization-maintenance", "platform-admin", "platform-hub-connect", "platform-migrator"]) {
      expect(manifest).toContain(`KOKORO_SERVICE_PACKAGE=${role}`);
      expect(entrypoint).toContain(`"${role}"`);
    }
    expect(manifest).toContain("credentialClass: platform-api");
    expect(manifest).toContain("credentialClass: platform-admission");
    expect(manifest).toContain("expectedUserEnvironmentVariable: PLATFORM_DATABASE_ADMISSION_ROLE");
    expect(manifest).toContain(
      "declaredInboundContracts: [platform-admission-connect, platform-asset-eligibility-connect]",
    );
    for (const role of ["commerce-worker", "site-worker", "asset-worker", "admin-worker",
      "model-image-worker",
      "authorization-maintenance"]) expect(manifest).toContain(`credentialClass: ${role}`);
    expect(manifest).toContain("credentialClass: platform-identity-worker");
    expect(manifest).toContain(
      "expectedUserEnvironmentVariable: PLATFORM_DATABASE_IDENTITY_WORKER_ROLE",
    );
    expect(manifest).toContain("identity-verification-delivery-https");
    expect(manifest).toContain("identity-audit-digest-key");
    expect(manifest).toContain("identity-delivery-hmac-key");
    expect(manifest).toContain(
      "expectedUserEnvironmentVariable: PLATFORM_DATABASE_MODEL_IMAGE_WORKER_ROLE",
    );
    expect(manifest).toContain("certified-image-provider-effects-v1");
    expect(manifest).toContain("credentialClass: platform-model-gateway");
    expect(manifest).toContain("expectedUserEnvironmentVariable: PLATFORM_DATABASE_MODEL_GATEWAY_ROLE");
    expect(manifest).toContain("platform-model-gateway-reconciliation-https");
    expect(manifest).toContain("credentialClass: platform-asset-data-plane");
    expect(manifest).toContain("expectedUserEnvironmentVariable: PLATFORM_DATABASE_ASSET_DATA_PLANE_ROLE");
    expect(manifest).toContain("credentialClass: platform-authorization");
    expect(manifest).toContain("expectedUserEnvironmentVariable: PLATFORM_DATABASE_AUTHORIZATION_ROLE");
    expect(manifest).toContain("credentialClass: platform-admin");
    expect(manifest).toContain("credentialClass: platform-migrator");
    for (const environmentName of [
      "PLATFORM_DATABASE_MEMORY_PUBLIC_ROLE",
      "PLATFORM_DATABASE_MEMORY_RUNTIME_ROLE",
      "PLATFORM_DATABASE_MEMORY_WORKER_ROLE",
    ]) expect(manifest).toContain(environmentName);
    expect(manifest).toContain("id: platform-admin-authority-bootstrap");
    expect(manifest).toContain("initial-admin-authority-document");
    expect(manifest).toContain("site-release-certification-verification-keyring");
    expect(entrypoint).not.toContain('"platform-admin-authority-bootstrap"');
  });
});

function safeRole(roleName: string): Record<string, unknown> {
  return {
    roleName,
    isSuperuser: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canReplicate: false,
    canBypassRls: false,
    inheritsPrivileges: false,
    hasAnyMembership: false,
    isMigratorMember: false,
    isPeerMember: false,
    ownsAnyDatabase: false,
  };
}

function memoryRoleNames(): Readonly<Record<"public" | "runtime" | "worker", string>> {
  return Object.freeze({
    public: "platform_memory_public",
    runtime: "platform_memory_runtime",
    worker: "platform_memory_worker",
  });
}

function safeMemoryRole(roleName: string): Record<string, unknown> {
  return {
    ...safeRole(roleName),
    canLogin: true,
    ownsAnySchema: false,
    ownsAnyRelation: false,
    ownsAnySequence: false,
    ownsAnyRoutine: false,
    ownsAnyType: false,
    ownsAnyTablespace: false,
  };
}

function safeMemoryRoles(): readonly Record<string, unknown>[] {
  return Object.entries(memoryRoleNames()).map(([roleKind, roleName]) => ({
    ...safeMemoryRole(roleName),
    roleKind,
  }));
}

function authority(roleName: string): Record<string, unknown> {
  return {
    roleName,
    schemaOwner: "platform_migrator",
    foundationOwner: "platform_migrator",
    publicCanUseSchema: false,
    publicCanCreateSchema: false,
    canUseSchema: true,
    canCreateSchema: false,
    canReadFoundation: true,
    canMutateFoundation: false,
    ownsPlatformRelation: false,
    ownsPlatformFunction: false,
    hasRequiredPlatformWrites: true,
    hasIdentityOutboxConsumerAuthority: false,
    canExecuteModelInventoryImport: roleName === "platform_admin",
    canExecuteModelInventoryActivate: roleName === "platform_admin",
    canExecuteModelSitePolicyChange: roleName === "platform_admin",
    canExecuteModelCandidatesProjection: roleName === "platform_api",
    canExecuteModelDecisionProjection: roleName === "platform_api",
    canExecuteModelAvailabilityReport: false,
    canExecuteCreditScopePolicy:
      roleName === "platform_api" ||
      roleName === "platform_admission" ||
      roleName === "platform_admin",
    canExecuteCommerceSafeLabel:
      roleName === "platform_api" || roleName === "platform_admin",
    canExecuteCommerceIanaZone: roleName === "platform_admin",
    canReadCommerceCatalogEpoch: roleName === "platform_admin",
    canUpdateCommerceCatalogEpoch: roleName === "platform_admin",
    canExecuteAdminAuthorityChange: false,
    hasRequiredModelOptionFunctions: true,
    canSelectModelCatalogTable: roleName === "platform_admin",
    canReadModelSensitiveColumn: false,
    hasUnexpectedPlatformPrivilege: false,
  };
}

function splitAuthority(): Record<string, unknown> {
  return {
    roleAuthorityExact: true,
    relationAuthorityExact: true,
    routineAuthorityExact: true,
    publicRelationAuthorityClosed: true,
    publicRoutineAuthorityClosed: true,
    sequenceAuthorityClosed: true,
  };
}

function splitWorkerPolicyLookup(
  values: readonly unknown[] | undefined,
): Record<string, unknown> {
  const relationName = String(values?.[0]);
  const policyName = String(values?.[1]);
  const authority = Object.values(SPLIT_WORKER_RLS_AUTHORITY).find((candidate) =>
    candidate.policies.some(([relation, policy]) =>
      relation === relationName && policy === policyName));
  if (authority === undefined) throw new Error("SPLIT_WORKER_POLICY_FIXTURE_MISSING");
  return {
    relationName,
    policyName,
    usingExpression:
      `(current_setting('app.workload_kind'::text, true) = ` +
      `'${authority.workloadKind}'::text)`,
    withCheckExpression: null,
  };
}

function splitWorkerPolicyRows(): readonly Record<string, unknown>[] {
  const roles = {
    "site-worker": "platform_site_worker",
    "asset-worker": "platform_asset_worker",
    "admin-worker": "platform_admin_worker",
  } as const;
  const runtimePolicies = Object.entries(SPLIT_WORKER_RLS_AUTHORITY).flatMap(([role, authority]) =>
    authority.policies.map(([relationName, policyName]) => ({
      relationName,
      policyName,
      usingExpression:
        `((CURRENT_USER = '${roles[role as keyof typeof roles]}'::name) AND ` +
        `(current_setting('app.workload_kind'::text, true) = ` +
        `'${authority.workloadKind}'::text))`,
      withCheckExpression: null,
    })),
  );
  const definerPolicies = SPLIT_WORKER_DEFINER_RLS_AUTHORITY.map((authority) => ({
    relationName: authority.relationName,
    policyName: authority.policyName,
    command: authority.command,
    permissive: true,
    schemaOwnerOnly: true,
    usingExpression:
      `(platform.split_worker_role_identity_is_current('${authority.authorityRole}'::text) AND ` +
      `current_setting('app.workload_kind'::text,true)='${authority.workloadKind}'::text AND ` +
      `current_setting('app.operation'::text,true)='${authority.operation}'::text` +
      `${authority.requiresAdminExecution
        ? " AND current_setting('app.admin_execution'::text,true)='true'::text"
        : ""})`,
    withCheckExpression: null,
  }));
  return [...runtimePolicies, ...definerPolicies];
}

function outboxPolicyRows(): readonly Record<string, unknown>[] {
  return [
    ["outbox_asset_function_insert", "a", "platform_migrator", ["asset"]],
    ["outbox_admin_insert", "a", "platform_admin",
      ["admin-execution", "commerce", "site"]],
    ["outbox_admin_select", "r", "platform_admin",
      ["admin-execution", "commerce", "site"]],
    ["outbox_admission_insert", "a", "platform_admission", ["credit"]],
    ["outbox_api_insert", "a", "platform_api", ["identity", "commerce", "asset"]],
    ["outbox_api_select", "r", "platform_api", ["identity", "commerce", "asset"]],
    ["outbox_identity_worker_select", "r", "platform_identity_worker", ["identity"]],
    ["outbox_identity_worker_update", "w", "platform_identity_worker", ["identity"]],
    ["outbox_commerce_worker_select", "r", "platform_commerce_worker",
      ["commerce", "credit"]],
    ["outbox_commerce_worker_update", "w", "platform_commerce_worker",
      ["commerce", "credit"]],
    ["outbox_site_worker_select", "r", "platform_site_worker", ["site"]],
    ["outbox_site_worker_update", "w", "platform_site_worker", ["site"]],
    ["outbox_asset_worker_insert", "a", "platform_asset_worker", ["asset"]],
    ["outbox_asset_worker_select", "r", "platform_asset_worker", ["asset"]],
    ["outbox_asset_worker_update", "w", "platform_asset_worker", ["asset"]],
    ["outbox_admin_worker_select", "r", "platform_admin_worker", ["admin-execution"]],
    ["outbox_admin_worker_update", "w", "platform_admin_worker", ["admin-execution"]],
  ].map(([policyName, command, role, owners], index) => {
    const expression = `CURRENT_USER='${role}'::name AND owner=ANY(ARRAY[${
      (owners as string[]).map((owner) => `'${owner}'::text`).join(",")
    }])`;
    return {
      policyName,
      command,
      permissive: true,
      roleOids: [String(index + 10)],
      roles: [role],
      usingExpression: command === "a" ? null : expression,
      withCheckExpression: command === "r" ? null : expression,
    };
  });
}

function safeMigratorAuthority(): Record<string, unknown> {
  return {
    serverMajor: 18,
    currentUser: "platform_migrator",
    currentDatabase: "kokoro_platform",
    databaseOwner: "platform_migrator",
    isSuperuser: false,
    canCreateDatabase: false,
    canCreateRole: false,
    canReplicate: false,
    canBypassRls: false,
    inheritsPrivileges: false,
    hasAnyMembership: false,
    isApiMember: false,
    isAdmissionMember: false,
    isAuthorizationMember: false,
    isWorkerMember: false,
    isAdminMember: false,
    canCreateDatabaseObject: true,
    schemaExists: false,
    schemaOwner: null,
    publicCanUseSchema: false,
    publicCanCreateSchema: false,
  };
}

function migratorEnvironment(): Record<string, string> {
  return {
    ...commonEnvironment,
    DATABASE_URL_PLATFORM: migratorUrl,
    PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
    PLATFORM_DATABASE_API_ROLE: "platform_api",
    PLATFORM_DATABASE_ADMIN_ROLE: "platform_admin",
  };
}

function fakeDatabase(calls: string[]): PlatformDatabaseClient {
  return {
    async connect() {
      calls.push("connect");
    },
    async disconnect() {
      calls.push("disconnect");
    },
    async checkHealth() {
      calls.push("health");
    },
  };
}
