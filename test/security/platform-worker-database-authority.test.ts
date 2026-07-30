import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  loadPlatformDatabaseConfig,
  PLATFORM_WORKER_DATABASE_AUTHORITY,
} from "../../src/infrastructure/postgres/client.js";
import {
  canonicalRelationAuthority,
  compareUtf8Bytewise,
  splitWorkerRelationNames,
  SPLIT_WORKER_EXACT_AUTHORITY_SQL,
  SPLIT_WORKER_RELATION_AUTHORITY,
  type SplitWorkerRole,
} from "../../src/infrastructure/postgres/split-worker-authority.js";

const workerAuthorities = [
  ["commerce-worker", "platform_commerce_worker", "PLATFORM_DATABASE_COMMERCE_WORKER_ROLE"],
  ["site-worker", "platform_site_worker", "PLATFORM_DATABASE_SITE_WORKER_ROLE"],
  ["asset-worker", "platform_asset_worker", "PLATFORM_DATABASE_ASSET_WORKER_ROLE"],
  ["admin-worker", "platform_admin_worker", "PLATFORM_DATABASE_ADMIN_WORKER_ROLE"],
  ["identity-worker", "platform_identity_worker", "PLATFORM_DATABASE_IDENTITY_WORKER_ROLE"],
  [
    "authorization-maintenance",
    "platform_authorization_maintenance",
    "PLATFORM_DATABASE_AUTHORIZATION_MAINTENANCE_ROLE",
  ],
] as const;

describe("Platform worker database authority split", () => {
  it("binds every worker operation to one exact role and workload kind", () => {
    expect(PLATFORM_WORKER_DATABASE_AUTHORITY).toEqual({
      "commerce-worker": {
        workloadKind: "platform_commerce_worker",
        internalOperations: ["commerce.outbox.reconcile"],
        scopedOperations: [],
        adminExecution: false,
      },
      "site-worker": {
        workloadKind: "platform_site_worker",
        internalOperations: ["site.runtime.consume"],
        scopedOperations: [],
        adminExecution: false,
      },
      "asset-worker": {
        workloadKind: "platform_asset_worker",
        internalOperations: ["asset.outbox.consume"],
        scopedOperations: [
          "asset.upload-completion.observe",
          "asset.scan.evaluate",
          "asset.promotion.finalize",
          "asset.cleanup.delete",
        ],
        adminExecution: false,
      },
      "admin-worker": {
        workloadKind: "platform_admin_worker",
        internalOperations: ["admin.execution.claim", "admin.execution.retry", "admin.terminalize"],
        scopedOperations: [],
        adminExecution: true,
      },
      "identity-worker": {
        workloadKind: "platform_identity_worker",
        internalOperations: ["identity.outbox.consume"],
        scopedOperations: [],
        adminExecution: false,
      },
      "authorization-maintenance": {
        workloadKind: "platform_authorization_maintenance",
        internalOperations: ["authorization.retention"],
        scopedOperations: [],
        adminExecution: false,
      },
    });

    const operationOwners = Object.values(PLATFORM_WORKER_DATABASE_AUTHORITY).flatMap((authority) =>
      authority.internalOperations.map((operation) => [operation, authority.workloadKind] as const),
    );
    expect(new Set(operationOwners.map(([operation]) => operation)).size).toBe(
      operationOwners.length,
    );
  });

  it.each(workerAuthorities)(
    "loads the exact %s credential without a generic worker fallback",
    (credentialClass, roleName, roleEnvironmentName) => {
      const config = loadPlatformDatabaseConfig(credentialClass, {
        DATABASE_URL_PLATFORM: `postgresql://${roleName}:secret@localhost:5432/kokoro_platform`,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: credentialClass,
        PLATFORM_DATABASE_EXPECTED_DATABASE: "kokoro_platform",
        PLATFORM_DATABASE_MIGRATOR_ROLE: "platform_migrator",
        [roleEnvironmentName]: roleName,
      });

      expect(config).toMatchObject({
        role: credentialClass,
        credentialClass,
        expectedDatabaseUser: roleName,
      });
    },
  );

  it("does not expose the retired generic worker credential through the client API", async () => {
    const [client, worker] = await Promise.all([
      readFile("src/infrastructure/postgres/client.ts", "utf8"),
      readFile("src/process/worker.ts", "utf8"),
    ]);
    const processRole = client.match(/export type PlatformProcessRole\s*=([\s\S]+?);/u)?.[1] ?? "";
    expect(processRole).not.toMatch(/\|\s*"worker"\b/u);
    expect(client).not.toContain('Exclude<PlatformProcessRole, "worker">');
    expect(client).not.toContain('role === "worker"');
    expect(worker).not.toContain("loadPlatformDatabaseConfig");
    expect(worker).not.toContain("runPlatformWorkerMain");
    expect(worker).toContain("PLATFORM_AGGREGATE_WORKER_REMOVED");
  });

  it("derives every relation allowlist from the one authority catalog", async () => {
    for (const role of Object.keys(SPLIT_WORKER_RELATION_AUTHORITY) as SplitWorkerRole[]) {
      const expected = [
        ...new Set(SPLIT_WORKER_RELATION_AUTHORITY[role].map((authority) => authority.relation)),
      ].sort(compareUtf8Bytewise);
      expect(splitWorkerRelationNames(role)).toEqual(expected);
    }

    const [client, migrator] = await Promise.all([
      readFile("src/infrastructure/postgres/client.ts", "utf8"),
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
    ]);
    expect(client).not.toContain("const SPLIT_WORKER_ALLOWED_RELATIONS");
    expect(migrator).not.toContain("const SPLIT_WORKER_ALLOWED_RELATIONS");
  });

  it("canonicalizes authority evidence with explicit UTF-8 byte order", () => {
    expect(["é", "z", "😀", "aa", "a"].sort(compareUtf8Bytewise)).toEqual([
      "a",
      "aa",
      "z",
      "é",
      "😀",
    ]);
    for (const role of Object.keys(SPLIT_WORKER_RELATION_AUTHORITY) as SplitWorkerRole[]) {
      const authority = canonicalRelationAuthority(role);
      const keys = authority.map(
        (row) => `${row.relation}:${row.privilege}:${row.columnName ?? ""}`,
      );
      expect(keys).toEqual([...keys].sort(compareUtf8Bytewise));
    }
  });

  it("audits the complete LOGIN NOINHERIT role envelope including TEMP and ownership", () => {
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("runtime_role.rolcanlogin");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("runtime_role.rolinherit");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("'CREATE'");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("'TEMPORARY'");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("pg_auth_members");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("database_row.datdba<>runtime_role.oid");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("relation.relowner=runtime_role.oid");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).toContain("routine.proowner=runtime_role.oid");
    expect(SPLIT_WORKER_EXACT_AUTHORITY_SQL).not.toContain(
      "COALESCE(attribute.attacl,ARRAY[]::ACLITEM[])",
    );
  });

  it("sorts persisted SQL authority evidence with the same bytewise comparator", async () => {
    const migrator = await readFile("src/infrastructure/postgres/migrator.ts", "utf8");
    expect(migrator).toContain("compareUtf8Bytewise(String(left.policyName)");
    expect(migrator).not.toContain("localeCompare");
  });

  it("provisions only the six exact worker principals", async () => {
    const provision = await readFile("scripts/ci/provision-platform-postgres.sql", "utf8");
    for (const [, roleName] of workerAuthorities) {
      expect(provision).toContain(`CREATE ROLE ${roleName}`);
      expect(provision).toContain(roleName);
    }
    expect(provision).not.toMatch(/CREATE ROLE platform_worker\b/u);
    expect(provision).not.toMatch(/^\s*platform_worker,?$/mu);
  });

  it("migrates and audits every exact worker role without the generic credential", async () => {
    const migrator = await readFile("src/infrastructure/postgres/migrator.ts", "utf8");
    for (const [credentialClass, , environmentName] of workerAuthorities) {
      expect(migrator).toContain(environmentName);
      expect(migrator).toContain(
        credentialClass.replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase()),
      );
    }
    expect(migrator).not.toContain("PLATFORM_DATABASE_WORKER_ROLE");
    expect(migrator).not.toMatch(/\bworkerRole\b/u);
    expect(migrator).toMatch(/report_model_provider_availability[\s\S]+TO \$\{gateway\}/u);
  });

  it("uses one role-bound outbox policy per exact consumer route", async () => {
    const [migrator, runtimePolicy] = await Promise.all([
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile("src/infrastructure/postgres/outbox-policy-authority.ts", "utf8"),
    ]);
    expect(runtimePolicy).toContain("OUTBOX_OWNER_POLICY_COUNT = 17");
    expect(migrator).toMatch(/commerceWorker[\s\S]+owners:\s*\["commerce",\s*"credit"\]/u);
    expect(migrator).toMatch(/siteWorker[\s\S]+owners:\s*\["site"\]/u);
    expect(migrator).toMatch(/assetWorker[\s\S]+owners:\s*\["asset"\]/u);
    expect(migrator).toMatch(/adminWorker[\s\S]+owners:\s*\["admin-execution"\]/u);
    const catalog = migrator.match(/const OUTBOX_OWNER_POLICIES[\s\S]+?\]\);/u)?.[0] ?? "";
    expect(catalog).not.toContain("outbox_worker_select");
    expect(catalog).not.toContain("outbox_worker_insert");
    expect(catalog).not.toContain("outbox_worker_update");
  });

  it("closes historical worker authority only through a forward migration", async () => {
    const migration = await readFile(
      "prisma/migrations/20260806_platform_worker_authority_split/migration.sql",
      "utf8",
    );
    expect(migration).toContain("REVOKE CONNECT ON DATABASE");
    expect(migration).toContain("REVOKE ALL ON SCHEMA platform FROM platform_worker");
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA platform FROM platform_worker",
    );
    expect(migration).toContain(
      "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA platform FROM platform_worker",
    );
    for (const workloadKind of [
      "platform_commerce_worker",
      "platform_site_worker",
      "platform_asset_worker",
      "platform_admin_worker",
      "platform_identity_worker",
      "platform_authorization_maintenance",
      "platform_model_gateway",
    ])
      expect(migration).toContain(workloadKind);
    expect(migration).not.toMatch(
      /current_setting\('app\.workload_kind'[^)]*\)\s*=\s*'platform_worker'/u,
    );
  });
});
