import { readFile, stat } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCoreSingleSiteBootstrapProductionRecovery,
  executeCoreSingleSiteBootstrap,
} from "../../src/process/core-single-site-bootstrap-composition.js";
import {
  publishCoreSingleSiteBootstrapOutputs,
  runCoreSingleSiteBootstrapMain,
} from "../../src/process/core-single-site-bootstrap.js";
import { resolvePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  createCoreSingleSiteBootstrapPostgresFixture,
  type CoreSingleSiteBootstrapPostgresFixture,
} from "./support/core-single-site-bootstrap-fixture.js";

type CompletedBootstrap = Awaited<ReturnType<typeof executeCoreSingleSiteBootstrap>>;

describe.sequential("core single-Site bootstrap PostgreSQL component", () => {
  let fixture: CoreSingleSiteBootstrapPostgresFixture | undefined;
  let completed: CompletedBootstrap | undefined;

  beforeAll(async () => {
    fixture = await createCoreSingleSiteBootstrapPostgresFixture();
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  it("boots the complete current authority through the four production role owners", async () => {
    const current = requiredFixture(fixture);
    completed = await executeCoreSingleSiteBootstrap(current.execution, current.owners);
    await publishCoreSingleSiteBootstrapOutputs({
      resultPath: current.paths.result,
      redemptionCodePath: current.paths.redemptionCode,
      result: completed.result,
      redemptionCode: completed.redemptionCode,
      persisted: completed.persisted,
      allowCreateCode: true,
    });
    const authority = await current.bootstrap.query<{
      activeSite: number;
      activeRelease: number;
      activeDeployment: number;
      activeProjectBinding: number;
      authorizationSites: number;
      authorizationReleases: number;
      authorizationBindings: number;
      modelCatalogs: number;
      capabilityCatalogs: number;
      launchProfiles: number;
      personalIdentities: number;
      ratingPolicies: number;
      creditPrograms: number;
      redemptionPrograms: number;
      activeCodeBatches: number;
      availableCodes: number;
    }>(
      `SELECT
         (SELECT count(*)::integer FROM platform.site
           WHERE site_ref=$1 AND state='active') AS "activeSite",
         (SELECT count(*)::integer FROM platform.site_release
           WHERE site_ref=$1 AND release_ref=$2 AND state='active') AS "activeRelease",
         (SELECT count(*)::integer FROM platform.site_deployment_binding
           WHERE site_ref=$1 AND release_ref=$2 AND state='active') AS "activeDeployment",
         (SELECT count(*)::integer FROM platform.site_project_binding
           WHERE site_ref=$1 AND binding_ref=$3 AND state='active') AS "activeProjectBinding",
         (SELECT count(*)::integer FROM platform.authorization_site
           WHERE site_ref=$1 AND state='active') AS "authorizationSites",
         (SELECT count(*)::integer FROM platform.authorization_site_release
           WHERE site_ref=$1 AND release_ref=$2 AND state='active') AS "authorizationReleases",
         (SELECT count(*)::integer FROM platform.authorization_product_binding
           WHERE site_ref=$1 AND release_ref=$2 AND binding_ref=$3 AND state='active')
           AS "authorizationBindings",
         (SELECT count(*)::integer FROM platform.site_release_model_catalog_publication
           WHERE site_id=$1 AND site_release_ref=$2) AS "modelCatalogs",
         (SELECT count(*)::integer FROM platform.admission_capability_catalog_snapshot
           WHERE site_ref=$1 AND site_release_ref=$2) AS "capabilityCatalogs",
         (SELECT count(*)::integer FROM platform.admission_launch_profile_snapshot
           WHERE site_ref=$1 AND site_release_ref=$2) AS "launchProfiles",
         (SELECT count(*)::integer FROM platform.identity_personal_bootstrap
           WHERE site_ref=$1 AND subject_ref=$4) AS "personalIdentities",
         (SELECT count(*)::integer FROM platform.credit_rating_policy_revision
           WHERE site_ref=$1 AND rating_policy_revision_ref=$5 AND state='published')
           AS "ratingPolicies",
         (SELECT count(*)::integer FROM platform.commerce_credit_program_revision
           WHERE site_ref=$1 AND credit_program_revision_ref=$6) AS "creditPrograms",
         (SELECT count(*)::integer FROM platform.commerce_redemption_program_revision
           WHERE site_ref=$1 AND redemption_program_revision_ref=$7) AS "redemptionPrograms",
         (SELECT count(*)::integer FROM platform.commerce_code_batch
           WHERE site_ref=$1 AND batch_ref=$8::uuid AND state='active') AS "activeCodeBatches",
         (SELECT count(*)::integer FROM platform.commerce_redeem_code
           WHERE site_ref=$1 AND batch_ref=$8::uuid AND state='available') AS "availableCodes"`,
      [
        current.document.site.siteId,
        current.document.site.siteReleaseRef,
        current.document.site.siteProjectBindingRef,
        current.document.identity.subjectRef,
        current.document.rating.policyRevisionRef,
        current.document.redemption.creditProgramRevisionRef,
        current.document.redemption.programRevisionRef,
        current.document.redemption.batchRef,
      ],
    );

    expect(completed.result).toMatchObject({
      site: { state: "active" },
      redemption: { state: "active" },
    });
    expect(completed.persisted).toMatchObject({
      keyRevision: current.initialCodeKeyRevision,
      state: "available",
    });
    expect(authority.rows).toEqual([{
      activeSite: 1,
      activeRelease: 1,
      activeDeployment: 1,
      activeProjectBinding: 1,
      authorizationSites: 1,
      authorizationReleases: 1,
      authorizationBindings: 1,
      modelCatalogs: 1,
      capabilityCatalogs: 1,
      launchProfiles: 1,
      personalIdentities: 1,
      ratingPolicies: 1,
      creditPrograms: 1,
      redemptionPrograms: 1,
      activeCodeBatches: 1,
      availableCodes: 1,
    }]);
  }, 30_000);

  it("replays the completed receipt without attestations or effect-database connections", async () => {
    const current = requiredFixture(fixture);
    const first = requiredCompleted(completed);
    const before = await outputContents(current);
    const stdout: string[] = [];

    await expect(runCoreSingleSiteBootstrapMain({
      argv: current.mainArguments(),
      environment: current.lazyReplayEnvironment(),
      writeStdout: (value) => stdout.push(value),
      now: freshAuthorityForbidden,
    })).resolves.toMatchObject({ resultPath: current.paths.result });

    expect(await outputContents(current)).toEqual(before);
    expect(JSON.parse(await readFile(current.paths.result, "utf8"))).toEqual(first.result);
    expect((await readFile(current.paths.redemptionCode, "utf8")).trim())
      .toBe(first.redemptionCode);
    expect(stdout).toHaveLength(1);
  });

  it("rejects configuration drift before reading fresh authority or effect databases", async () => {
    const current = requiredFixture(fixture);
    const driftedDocument = {
      ...current.document,
      rating: {
        ...current.document.rating,
        inputTokenAmount: String(BigInt(current.document.rating.inputTokenAmount) + 1n),
      },
    };
    const driftedPath = await current.writeDocument(driftedDocument, "drifted-document.json");

    await expect(runCoreSingleSiteBootstrapMain({
      argv: current.mainArguments(driftedPath),
      environment: current.lazyReplayEnvironment(),
      writeStdout: () => undefined,
      now: freshAuthorityForbidden,
    })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_CONFIGURATION_CONFLICT");
  });

  it("enforces exact definer ACL/RLS/GUC authority and rejects a drifted current projection", async () => {
    const current = requiredFixture(fixture);
    const functionAuthority = await current.bootstrap.query<{
      signature: string;
      owner: string;
      schemaOwner: string;
      securityDefiner: boolean;
      volatility: string;
      configuration: string[] | null;
      adminExecute: boolean;
      apiExecute: boolean;
      admissionExecute: boolean;
      siteWorkerExecute: boolean;
      identityWorkerExecute: boolean;
      publicDenied: boolean;
    }>(
      `SELECT routine.oid::regprocedure::text AS signature,
              owner.rolname AS owner,schema_owner.rolname AS "schemaOwner",
              routine.prosecdef AS "securityDefiner",routine.provolatile::text AS volatility,
              routine.proconfig AS configuration,
              has_function_privilege($1,routine.oid,'EXECUTE') AS "adminExecute",
              has_function_privilege($2,routine.oid,'EXECUTE') AS "apiExecute",
              has_function_privilege($3,routine.oid,'EXECUTE') AS "admissionExecute",
              has_function_privilege($4,routine.oid,'EXECUTE') AS "siteWorkerExecute",
              has_function_privilege($5,routine.oid,'EXECUTE') AS "identityWorkerExecute",
              NOT EXISTS (
                SELECT 1 FROM aclexplode(COALESCE(
                  routine.proacl,acldefault('f',routine.proowner)
                )) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
              ) AS "publicDenied"
       FROM pg_proc routine
       JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       JOIN pg_roles owner ON owner.oid=routine.proowner
       JOIN pg_roles schema_owner ON schema_owner.oid=namespace.nspowner
       WHERE routine.oid=ANY(ARRAY[
         to_regprocedure('platform.core_single_site_bootstrap_identity_ready(text,uuid,text,text,text,text,text,text)'),
         to_regprocedure('platform.core_single_site_bootstrap_model_catalog_ready(text,text,text)')
       ]) ORDER BY routine.oid::regprocedure::text`,
      [
        current.environment.PLATFORM_DATABASE_ADMIN_ROLE,
        current.environment.PLATFORM_DATABASE_API_ROLE,
        current.environment.PLATFORM_DATABASE_ADMISSION_ROLE,
        current.environment.PLATFORM_DATABASE_SITE_WORKER_ROLE,
        current.environment.PLATFORM_DATABASE_IDENTITY_WORKER_ROLE,
      ],
    );
    expect(functionAuthority.rows).toHaveLength(2);
    for (const row of functionAuthority.rows) {
      expect(row).toMatchObject({
        owner: current.environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
        schemaOwner: current.environment.PLATFORM_DATABASE_MIGRATOR_ROLE,
        securityDefiner: true,
        volatility: "s",
        adminExecute: true,
        apiExecute: false,
        admissionExecute: false,
        siteWorkerExecute: false,
        identityWorkerExecute: false,
        publicDenied: true,
      });
      expect(row.configuration?.map((value) => value.replaceAll(" ", "")))
        .toEqual(["search_path=pg_catalog,platform"]);
    }

    const verified = await current.databases.admin.coreBootstrapRecoveryTransaction({
      bootstrapId: current.document.bootstrapId,
      siteRef: current.document.site.siteId,
      makerSubjectRef: current.document.makerSubjectRef,
      environment: current.document.environment,
      region: current.document.region,
    }, async (transaction) => {
      const sql = resolvePlatformTransaction(transaction);
      const before = await recoverySettings(sql);
      const rows = await sql.query<{ identityReady: boolean; modelReady: boolean }>(
        `SELECT platform.core_single_site_bootstrap_identity_ready(
                  $1,$2::uuid,$3,$4,$5,$6,$7,$8
                ) AS "identityReady",
                platform.core_single_site_bootstrap_model_catalog_ready(
                  $1,$9,$10
                ) AS "modelReady"`,
        [
          current.document.site.siteId,
          current.document.identity.accountRef,
          current.document.identity.subjectRef,
          current.document.identity.workspaceRef,
          current.document.identity.projectRef,
          current.document.identity.billingAccountRef,
          current.document.identity.executionSpaceRef,
          current.document.identity.executionNamespace,
          current.document.site.siteReleaseRef,
          current.execution.recipe.modelOptionCatalogRef,
        ],
      );
      const after = await recoverySettings(sql);
      return { rows, before, after };
    });
    expect(verified.rows).toEqual([{ identityReady: true, modelReady: true }]);
    expect(verified.after).toEqual(verified.before);
    expect(verified.before.transactionReadOnly).toBe("on");

    const admin = await connectedRoleClient(current, "DATABASE_URL_PLATFORM_ADMIN");
    const api = await connectedRoleClient(current, "DATABASE_URL_PLATFORM_API");
    try {
      await expect(admin.query(
        "SELECT account_ref FROM platform.identity_account WHERE site_ref=$1",
        [current.document.site.siteId],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(api.query(
        `SELECT platform.core_single_site_bootstrap_model_catalog_ready($1,$2,$3)`,
        [current.document.site.siteId, current.document.site.siteReleaseRef,
          current.execution.recipe.modelOptionCatalogRef],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(admin.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM platform.site_release_model_catalog_publication WHERE site_id=$1`,
        [current.document.site.siteId],
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await Promise.all([admin.end(), api.end()]);
    }

    await privilegedMutation(current,
      `UPDATE platform.authorization_product_binding SET state='revoked'
       WHERE site_ref=$1 AND release_ref=$2 AND binding_ref=$3`,
      [current.document.site.siteId, current.document.site.siteReleaseRef,
        current.document.site.siteProjectBindingRef]);
    try {
      const recovery = createCoreSingleSiteBootstrapProductionRecovery(current.databases.admin);
      await expect(recovery.recover({
        document: current.document,
        recipe: current.execution.recipe,
        configDigest: current.execution.configDigest,
      })).rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_READBACK_NOT_READY");
    } finally {
      await privilegedMutation(current,
        `UPDATE platform.authorization_product_binding SET state='active'
         WHERE site_ref=$1 AND release_ref=$2 AND binding_ref=$3`,
        [current.document.site.siteId, current.document.site.siteReleaseRef,
          current.document.site.siteProjectBindingRef]);
    }
  }, 30_000);

  it("fails a missing or rolled-back workload binding epoch closed without an RLS cast error", async () => {
    const current = requiredFixture(fixture);
    const admission = await connectedRoleClient(
      current,
      "DATABASE_URL_PLATFORM_ADMISSION",
    );
    try {
      await expect(admission.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM platform.site_project_binding",
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });

      await admission.query("BEGIN");
      await admission.query(
        "SELECT set_config('app.workload_binding_epoch','1',true)",
      );
      await admission.query("COMMIT");
      await expect(admission.query<{ value: string }>(
        "SELECT current_setting('app.workload_binding_epoch',true) AS value",
      )).resolves.toMatchObject({ rows: [{ value: "" }] });
      await expect(admission.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM platform.site_project_binding",
      )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await admission.end();
    }
  });

  it("recovers the historical code after the key ring rotates", async () => {
    const current = requiredFixture(fixture);
    const first = requiredCompleted(completed);
    const before = await outputContents(current);
    await current.rotateCommerceCodeKey();

    await expect(runCoreSingleSiteBootstrapMain({
      argv: current.mainArguments(),
      environment: current.lazyReplayEnvironment(),
      writeStdout: () => undefined,
      now: freshAuthorityForbidden,
    })).resolves.toMatchObject({ resultPath: current.paths.result });

    const persisted = await current.bootstrap.query<{ keyRevision: string }>(
      `SELECT code_lookup_key_revision AS "keyRevision"
       FROM platform.commerce_redeem_code WHERE site_ref=$1 AND batch_ref=$2::uuid`,
      [current.document.site.siteId, current.document.redemption.batchRef],
    );
    expect(persisted.rows).toEqual([{ keyRevision: current.initialCodeKeyRevision }]);
    expect((await readFile(current.paths.redemptionCode, "utf8")).trim())
      .toBe(first.redemptionCode);
    expect(await outputContents(current)).toEqual(before);
  });

  it("verifies claimed terminal-code outputs in place without recreating them", async () => {
    const current = requiredFixture(fixture);
    const trackedPaths = [
      current.paths.result,
      current.paths.redemptionCode,
      `${current.paths.result}.pair`,
    ];
    const beforeContent = await outputContents(current);
    const beforeStats = await Promise.all(trackedPaths.map((path) => stat(path, { bigint: true })));
    await privilegedMutation(current,
      `UPDATE platform.commerce_redeem_code
       SET state='claimed',
           claimed_by_command_id=(
             SELECT command_id FROM platform.commerce_command
             WHERE site_ref=$1 ORDER BY created_at,command_id LIMIT 1
           ),
           claimed_at=now(),voided_at=NULL
       WHERE site_ref=$1 AND batch_ref=$2::uuid`,
      [current.document.site.siteId, current.document.redemption.batchRef]);

    await expect(runCoreSingleSiteBootstrapMain({
      argv: current.mainArguments(),
      environment: current.lazyReplayEnvironment(),
      writeStdout: () => undefined,
      now: freshAuthorityForbidden,
    })).resolves.toMatchObject({ resultPath: current.paths.result });

    const afterStats = await Promise.all(trackedPaths.map((path) => stat(path, { bigint: true })));
    expect(await outputContents(current)).toEqual(beforeContent);
    expect(afterStats.map(fileIdentity)).toEqual(beforeStats.map(fileIdentity));
    await expect(current.bootstrap.query<{ state: string }>(
      `SELECT state FROM platform.commerce_redeem_code
       WHERE site_ref=$1 AND batch_ref=$2::uuid`,
      [current.document.site.siteId, current.document.redemption.batchRef],
    )).resolves.toMatchObject({ rows: [{ state: "claimed" }] });
  });
});

function requiredFixture(
  value: CoreSingleSiteBootstrapPostgresFixture | undefined,
): CoreSingleSiteBootstrapPostgresFixture {
  if (value === undefined) throw new Error("CORE_BOOTSTRAP_COMPONENT_FIXTURE_REQUIRED");
  return value;
}

function requiredCompleted(value: CompletedBootstrap | undefined): CompletedBootstrap {
  if (value === undefined) throw new Error("CORE_BOOTSTRAP_COMPONENT_FIRST_RUN_REQUIRED");
  return value;
}

function freshAuthorityForbidden(): never {
  throw new Error("CORE_BOOTSTRAP_COMPONENT_FRESH_AUTHORITY_ACCESSED");
}

async function outputContents(
  fixture: CoreSingleSiteBootstrapPostgresFixture,
): Promise<readonly string[]> {
  return Promise.all([
    readFile(fixture.paths.result, "utf8"),
    readFile(fixture.paths.redemptionCode, "utf8"),
    readFile(`${fixture.paths.result}.pair`, "utf8"),
  ]);
}

async function connectedRoleClient(
  fixture: CoreSingleSiteBootstrapPostgresFixture,
  name: "DATABASE_URL_PLATFORM_ADMIN" | "DATABASE_URL_PLATFORM_API" |
  "DATABASE_URL_PLATFORM_ADMISSION",
): Promise<Client> {
  const connectionString = fixture.environment[name];
  if (connectionString === undefined) throw new Error(`${name}_REQUIRED`);
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function recoverySettings(
  sql: ReturnType<typeof resolvePlatformTransaction>,
): Promise<Readonly<{ settings: unknown; transactionReadOnly: string }>> {
  const names = [
    "app.operation",
    "app.site_id",
    "app.environment",
    "app.region",
    "app.workload_kind",
    "app.actor_kind",
    "app.subject_id",
    "app.subject_generation",
    "app.purpose",
    "app.scopes",
  ];
  const rows = await sql.query<{ settings: unknown; transactionReadOnly: string }>(
    `SELECT jsonb_object_agg(name,current_setting(name,true) ORDER BY name) AS settings,
            current_setting('transaction_read_only') AS "transactionReadOnly"
     FROM unnest($1::text[]) name`,
    [names],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error("CORE_BOOTSTRAP_COMPONENT_GUC_SNAPSHOT_INVALID");
  }
  return row;
}

async function privilegedMutation(
  fixture: CoreSingleSiteBootstrapPostgresFixture,
  statement: string,
  values: readonly unknown[],
): Promise<void> {
  await fixture.bootstrap.query("BEGIN");
  try {
    await fixture.bootstrap.query("SET LOCAL session_replication_role='replica'");
    const changed = await fixture.bootstrap.query(statement, [...values]);
    if (changed.rowCount !== 1) throw new Error("CORE_BOOTSTRAP_COMPONENT_MUTATION_MISSED");
    await fixture.bootstrap.query("COMMIT");
  } catch (error) {
    await fixture.bootstrap.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function fileIdentity(value: Awaited<ReturnType<typeof stat>>): Readonly<{
  inode: number | bigint;
  modified: number | bigint;
  size: number | bigint;
}> {
  return Object.freeze({ inode: value.ino, modified: value.mtimeMs, size: value.size });
}
