import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const id = "platform-core-bootstrap";
const selector = "platform-core-single-site-bootstrap";

const databases = Object.freeze([
  ["admin", "DATABASE_URL_PLATFORM_ADMIN", "PLATFORM_DATABASE_ADMIN_ROLE"],
  ["api", "DATABASE_URL_PLATFORM_API", "PLATFORM_DATABASE_API_ROLE"],
  ["site-worker", "DATABASE_URL_PLATFORM_SITE_WORKER", "PLATFORM_DATABASE_SITE_WORKER_ROLE"],
  ["identity-worker", "DATABASE_URL_PLATFORM_IDENTITY_WORKER",
    "PLATFORM_DATABASE_IDENTITY_WORKER_ROLE"],
]);

test("deployable inventory declares the one-shot core bootstrap owner composition", async () => {
  const document = parse(await readFile(resolve(root, "deployables.yaml"), "utf8"));
  const deployable = document.deployables.find((entry) => entry.id === id);

  assert.ok(deployable);
  assert.equal(deployable.processRole, "bootstrap");
  assert.equal(deployable.runtimeTraffic, false);
  assert.equal(deployable.activationAuthorized, false);
  assert.equal(deployable.selectorEnvironment, `KOKORO_SERVICE_PACKAGE=${selector}`);
  assert.equal(deployable.readiness, "one-shot-safe-result");
  assert.deepEqual(deployable.databases, databases.map(([
    processRole,
    environmentVariable,
    expectedUserEnvironmentVariable,
  ]) => ({
    processRole,
    environmentVariable,
    expectedUserEnvironmentVariable,
    migratorRoleEnvironmentVariable: "PLATFORM_DATABASE_MIGRATOR_ROLE",
    expectedDatabaseEnvironmentVariable: "PLATFORM_DATABASE_EXPECTED_DATABASE",
    credentialClass: processRole,
    ddl: "forbidden",
  })));
  for (const [, url, role] of databases) {
    assert.ok(deployable.requiredEnvironment.includes(url), url);
    assert.ok(deployable.requiredEnvironment.includes(role), role);
  }
  assert.ok(deployable.outboundContracts.includes("hub-capability-catalog"));
  assert.ok(deployable.outboundContracts.includes("site-deployment-provider-https"));
  assert.ok(!deployable.requiredEnvironment.some((name) =>
    name.startsWith("PLATFORM_IDENTITY_DELIVERY_")));
});

test("compiled selector recovers completion before opening fresh authority files", async () => {
  const [entrypoint, cli, composition] = await Promise.all([
    readFile(resolve(root, "deploy/docker/runtime-entrypoint.mjs"), "utf8"),
    readFile(resolve(root, "src/process/core-single-site-bootstrap.ts"), "utf8"),
    readFile(resolve(root, "src/process/core-single-site-bootstrap-composition.ts"), "utf8"),
  ]);
  assert.match(entrypoint, new RegExp(`"${selector}"`, "u"));
  assert.match(entrypoint, /start:\s*"runCoreSingleSiteBootstrapMain"/u);
  const recovery = cli.indexOf("recoverCompletedCoreSingleSiteBootstrap({");
  const freshAuthority = cli.indexOf("readBoundedPrivateFile(args.makerAttestation");
  assert.ok(recovery >= 0 && freshAuthority > recovery);
  assert.match(composition, /new IdentityOutboxConsumer/u);
  assert.match(composition, /CORE_BOOTSTRAP_UNEXPECTED_VERIFICATION_DELIVERY/u);
  assert.doesNotMatch(composition, /createIdentityOutboxWorkerProductionComposition/u);
});

test("bootstrap readback uses narrow owner functions across incompatible RLS policies", async () => {
  const [migration, migrator, client, composition, modelPolicy, outboxAuthority] =
    await Promise.all([
      readFile(resolve(root,
        "prisma/migrations/20260829_core_single_site_bootstrap_readback/migration.sql"), "utf8"),
      readFile(resolve(root, "src/infrastructure/postgres/migrator.ts"), "utf8"),
      readFile(resolve(root, "src/infrastructure/postgres/client.ts"), "utf8"),
      readFile(resolve(root, "src/process/core-single-site-bootstrap-composition.ts"), "utf8"),
      readFile(resolve(root,
        "prisma/migrations/20260803_model_control_admin_read_plane/migration.sql"), "utf8"),
      readFile(resolve(root, "src/infrastructure/postgres/migrator.ts"), "utf8"),
    ]);

  assert.match(modelPolicy,
    /site_release_model_catalog_admin_exact_scope[\s\S]*app\.workload_kind[^\n]*platform_admin/u);
  assert.match(outboxAuthority,
    /name:\s*"outbox_admin_select"[\s\S]*owners:\s*\["admin-execution",\s*"commerce",\s*"site"\]/u);
  assert.match(client,
    /coreBootstrapRecoveryTransaction[\s\S]*SET TRANSACTION READ ONLY[\s\S]*admin_workload/u);
  const identity = extractFunction(migration, "core_single_site_bootstrap_identity_ready");
  const model = extractFunction(migration, "core_single_site_bootstrap_model_catalog_ready");
  for (const definition of [identity, model]) {
    assert.match(definition, /LANGUAGE plpgsql STABLE SECURITY DEFINER/u);
    assert.match(definition, /SET search_path\s*=\s*pg_catalog,\s*platform/u);
    assert.match(definition, /app\.workload_kind[\s\S]*admin_workload/u);
    assert.match(definition, /app\.operation[\s\S]*core\.single-site\.bootstrap\.recover/u);
    assert.match(definition, /app\.site_id[\s\S]*p_site_ref/u);
  }
  assert.match(identity, /account\.account_ref=p_account_ref::TEXT/u);
  assert.match(identity, /execution\.project_ref=personal\.project_ref/u);
  assert.match(identity, /intent\.state='applied'/u);
  assert.match(identity, /execution\.state='active'/u);
  assert.doesNotMatch(identity, /outbox_event/u);
  assert.match(model, /site_release_model_catalog_publication/u);
  assert.doesNotMatch(model, /set_config/u);
  assert.match(migration,
    /REVOKE ALL ON FUNCTION platform\.core_single_site_bootstrap_identity_ready\(\s*TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT\s*\) FROM PUBLIC/u);
  assert.match(migration,
    /REVOKE ALL ON FUNCTION platform\.core_single_site_bootstrap_model_catalog_ready\(\s*TEXT,TEXT,TEXT\s*\) FROM PUBLIC/u);
  for (const source of [client, migrator]) {
    assert.match(source,
      /core_single_site_bootstrap_identity_ready\(text,uuid,text,text,text,text,text,text\)/u);
    assert.match(source,
      /core_single_site_bootstrap_model_catalog_ready\(text,text,text\)/u);
    assert.match(source, /proowner/u);
    assert.match(source, /prosecdef/u);
    assert.match(source, /provolatile/u);
    assert.match(source, /proconfig/u);
    assert.match(source, /search_path=pg_catalog,platform/u);
    assert.match(source, /provolatile='s'/u);
  }
  const runtimeRevocation = /`REVOKE ALL ON FUNCTION `\s*\+\s*`platform\.core_single_site_bootstrap_identity_ready\(text,uuid,text,text,text,text,text,text\)/u
    .exec(migrator);
  const adminGrant = /`GRANT EXECUTE ON FUNCTION `\s*\+\s*`platform\.core_single_site_bootstrap_identity_ready\(text,uuid,text,text,text,text,text,text\)/u
    .exec(migrator);
  assert.ok(runtimeRevocation?.index !== undefined && adminGrant?.index !== undefined &&
    adminGrant.index > runtimeRevocation.index);
  assert.match(client,
    /ELSE\s+NOT has_function_privilege[\s\S]*core_single_site_bootstrap_identity_ready[\s\S]*AND NOT has_function_privilege[\s\S]*core_single_site_bootstrap_model_catalog_ready/u);
  assert.match(composition, /platform\.core_single_site_bootstrap_identity_ready/u);
  assert.match(composition, /platform\.core_single_site_bootstrap_model_catalog_ready/u);
  assert.doesNotMatch(composition, /JOIN platform\.outbox_event namespace_event/u);
  assert.doesNotMatch(composition,
    /FROM platform\.site_release_model_catalog_publication catalog/u);
  assert.doesNotMatch(composition, /model_inventory_pointer/u);
  assert.match(composition, /ON CONFLICT DO NOTHING/u);
  assert.doesNotMatch(composition, /ON CONFLICT \(command_id\) DO NOTHING/u);
});

function extractFunction(source, functionName) {
  const start = source.indexOf(`CREATE FUNCTION platform.${functionName}(`);
  assert.notEqual(start, -1, functionName);
  const end = source.indexOf("\n$$;", start);
  assert.notEqual(end, -1, functionName);
  return source.slice(start, end + 4);
}
