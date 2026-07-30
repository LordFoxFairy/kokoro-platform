import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SPLIT_WORKER_RELATION_AUTHORITY } from "../../src/infrastructure/postgres/split-worker-authority.js";

describe("Identity outbox production authority", () => {
  it("preserves applied migrations and keeps Asset completion INSERT-only under RLS", async () => {
    const [historicalMigration, firstCorrection, rlsCorrection] = await Promise.all([
      readFile(
        "prisma/migrations/20260729_zz_asset_multipart_data_plane/migration.sql",
        "utf8",
      ),
      readFile(
        "prisma/migrations/20260805_asset_completion_collision_authority/migration.sql",
        "utf8",
      ),
      readFile(
        "prisma/migrations/20260806_asset_completion_rls_insert/migration.sql",
        "utf8",
      ),
    ]);
    expect(historicalMigration).toContain("ON CONFLICT (event_id) DO UPDATE");
    expect(historicalMigration).not.toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(firstCorrection).toContain(
      "CREATE OR REPLACE FUNCTION platform.enqueue_asset_upload_completion_event(",
    );
    expect(firstCorrection).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(firstCorrection).not.toMatch(/ON CONFLICT[\s\S]+DO UPDATE/u);
    expect(firstCorrection).toContain(
      "RAISE EXCEPTION 'ASSET_COMPLETION_OUTBOX_EVENT_CONFLICT' USING ERRCODE='23505'",
    );
    expect(rlsCorrection).toContain(
      "CREATE OR REPLACE FUNCTION platform.enqueue_asset_upload_completion_event(",
    );
    expect(rlsCorrection).not.toMatch(/\n\s*ON CONFLICT/u);
    expect(rlsCorrection).not.toContain("GET DIAGNOSTICS");
    expect(rlsCorrection).toContain("let the event_id primary key surface replay collisions");
  });

  it("binds policy permissiveness into the migrator catalog and every runtime audit", async () => {
    const [migrator, runtimeAuthority] = await Promise.all([
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile("src/infrastructure/postgres/outbox-policy-authority.ts", "utf8"),
    ]);
    expect(migrator).toContain('policy.polpermissive AS "permissive"');
    expect(migrator).toContain("actual?.permissive !== true");
    expect(migrator).toContain("permissive: policy.permissive");
    expect(runtimeAuthority).toContain("policy.polpermissive AS permissive");
    expect(runtimeAuthority).toContain("permissive BOOLEAN");
    expect(runtimeAuthority).toContain("actual.permissive IS DISTINCT FROM TRUE");
    expect(runtimeAuthority).toContain("expected.permissive IS DISTINCT FROM TRUE");
    expect(runtimeAuthority).toContain("actual.permissive IS DISTINCT FROM expected.permissive");
  });

  it("checks sequence privileges only against real sequences", async () => {
    const splitWorkerAuthority = await readFile(
      "src/infrastructure/postgres/split-worker-authority.ts",
      "utf8",
    );
    expect(splitWorkerAuthority).not.toMatch(
      /relkind\s*=\s*'S'\s+AND\s+has_sequence_privilege\([^)]*\.oid/gu,
    );
    expect(splitWorkerAuthority).toContain("CASE WHEN sequence_row.relkind='S' THEN");
  });

  it("allows the Identity worker's exact column updates in both privilege audits", async () => {
    const client = await readFile("src/infrastructure/postgres/client.ts", "utf8");
    const exactIdentityUpdateAllowlist =
      /\$2 = 'identity-worker' AND candidate\.relname = ANY\(ARRAY\[\s*'outbox_event','identity_verification_delivery','identity_execution_space',\s*'identity_namespace_allocation_intent'\s*\]\)/gu;
    expect([...client.matchAll(exactIdentityUpdateAllowlist)]).toHaveLength(2);
    expect(client).not.toMatch(
      /\$2 = 'worker' AND candidate\.relname = ANY\(ARRAY\[[^\]]*identity_verification_delivery/gu,
    );
  });

  it("persists bounded namespace failure evidence without storing verification credentials", async () => {
    const migration = await readFile(
      "prisma/migrations/20260804_identity_outbox_consumer/migration.sql",
      "utf8",
    );
    expect(migration).toContain("ALTER TABLE platform.identity_namespace_allocation_intent");
    expect(migration).toContain("ADD COLUMN last_error_code TEXT");
    expect(migration).toContain("length(last_error_code) BETWEEN 1 AND 128");
    expect(migration).not.toMatch(/verification_secret|email_normalized|sealed_envelope/iu);
  });

  it("gives the independent Identity worker only its projection reads and outcome updates", async () => {
    const [migrator, client, ownerFence] = await Promise.all([
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile("src/infrastructure/postgres/client.ts", "utf8"),
      readFile("prisma/migrations/20260804_outbox_owner_fencing/migration.sql", "utf8"),
    ]);
    const assetCompletionAuthority = await readFile(
      "prisma/migrations/20260806_asset_completion_rls_insert/migration.sql",
      "utf8",
    );
    expect(migrator).toContain("PLATFORM_DATABASE_IDENTITY_WORKER_ROLE");
    expect(migrator).toContain("grantSplitWorkerPrivileges");
    expect(migrator).toContain("SPLIT_WORKER_EXACT_AUTHORITY_SQL");
    expect(SPLIT_WORKER_RELATION_AUTHORITY["identity-worker"]).toEqual([
      { relation: "platform_foundation", privilege: "SELECT" },
      { relation: "outbox_event", privilege: "SELECT" },
      {
        relation: "outbox_event",
        privilege: "UPDATE",
        columns: [
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
        ],
      },
      {
        relation: "identity_verification_transaction",
        privilege: "SELECT",
        columns: ["site_ref", "transaction_ref", "state", "resend_count", "expires_at"],
      },
      {
        relation: "identity_verification_delivery",
        privilege: "SELECT",
        columns: ["event_id", "site_ref", "transaction_ref", "credential_revision", "state"],
      },
      {
        relation: "identity_verification_delivery",
        privilege: "UPDATE",
        columns: [
          "state",
          "attempt_count",
          "delivered_at",
          "failed_at",
          "superseded_at",
          "last_error_code",
          "updated_at",
        ],
      },
      {
        relation: "identity_personal_bootstrap",
        privilege: "SELECT",
        columns: [
          "site_ref",
          "subject_ref",
          "workspace_ref",
          "project_ref",
          "execution_space_ref",
          "execution_namespace",
          "namespace_intent_ref",
        ],
      },
      {
        relation: "identity_execution_space",
        privilege: "SELECT",
        columns: ["site_ref", "execution_space_ref", "project_ref", "execution_namespace", "state"],
      },
      {
        relation: "identity_execution_space",
        privilege: "UPDATE",
        columns: ["state", "updated_at"],
      },
      {
        relation: "identity_namespace_allocation_intent",
        privilege: "SELECT",
        columns: [
          "intent_ref",
          "event_id",
          "site_ref",
          "execution_space_ref",
          "execution_namespace",
          "state",
        ],
      },
      {
        relation: "identity_namespace_allocation_intent",
        privilege: "UPDATE",
        columns: ["state", "attempt_count", "last_error_code", "updated_at"],
      },
    ]);
    expect(SPLIT_WORKER_RELATION_AUTHORITY["identity-worker"]).not.toContainEqual(
      expect.objectContaining({ privilege: "INSERT" }),
    );
    expect(SPLIT_WORKER_RELATION_AUTHORITY["identity-worker"]).not.toContainEqual(
      expect.objectContaining({ privilege: "DELETE" }),
    );
    expect(migrator).toContain("configureOutboxOwnerPolicies");
    expect(migrator).toContain("ALTER TABLE platform.outbox_event FORCE ROW LEVEL SECURITY");
    expect(migrator).toContain("outbox_identity_worker_select");
    expect(migrator).toContain("outbox_identity_worker_update");
    expect(migrator).toMatch(/identityWorker[\s\S]+owners:\s*\["identity"\]/u);
    expect(migrator).toMatch(/commerceWorker[\s\S]+owners:\s*\["commerce",\s*"credit"\]/u);
    expect(migrator).not.toMatch(
      /GRANT UPDATE ON TABLE platform\.command_receipt, platform\.outbox_event/u,
    );
    expect(client).not.toMatch(
      /config\.role === "identity-worker"[\s\S]{0,400}has_table_privilege\(current_user, 'platform\.outbox_event', 'UPDATE'\)/u,
    );
    expect(migrator).toContain("current_user=");
    expect(migrator).toContain("membership.roleid=runtime_role.oid");
    expect(migrator).toMatch(
      /outbox_asset_function_insert[\s\S]+role:\s*"migrator"[\s\S]+owners:\s*\["asset"\]/u,
    );
    expect(client).toContain('AS "hasAnyMembers"');
    expect(client).toContain('outbox.relrowsecurity AS "outboxRlsEnabled"');
    expect(client).toContain('outbox.relforcerowsecurity AS "outboxForceRlsEnabled"');
    expect(client).toContain('AS "outboxPoliciesValid"');
    expect(client).toContain(
      "JOIN platform.platform_foundation foundation_marker ON foundation_marker.singleton=TRUE",
    );
    expect(client).toContain("identity.outboxPoliciesValid");
    expect(ownerFence).toContain("ALTER TABLE platform.outbox_event ENABLE ROW LEVEL SECURITY");
    expect(ownerFence).toContain("ALTER TABLE platform.outbox_event FORCE ROW LEVEL SECURITY");
    expect(ownerFence).not.toMatch(/current_setting|set_config|app\./u);
    expect(ownerFence).toContain("owner bypass are not part of this boundary");
    const assetCompletionFunction =
      assetCompletionAuthority.match(
        /CREATE OR REPLACE FUNCTION platform\.enqueue_asset_upload_completion_event[\s\S]+?REVOKE ALL ON FUNCTION/u,
      )?.[0] ?? "";
    expect(assetCompletionFunction).toContain("SECURITY DEFINER");
    expect(assetCompletionFunction).toContain("SET search_path=pg_catalog,platform");
    expect(assetCompletionFunction).not.toMatch(
      /ON CONFLICT|DO UPDATE|DELETE FROM platform\.outbox_event/u,
    );
  });

  it("isolates exact Identity claims and lease return in its own process", async () => {
    const [worker, identityWorker] = await Promise.all([
      readFile("src/process/worker.ts", "utf8"),
      readFile("src/process/identity-worker.ts", "utf8"),
    ]);
    const client = await readFile("src/infrastructure/postgres/client.ts", "utf8");
    const compose = await readFile("deploy/docker-compose.services.yml", "utf8");
    expect(worker).not.toContain("createIdentityOutboxWorkerProductionComposition");
    expect(worker).not.toContain("PLATFORM_IDENTITY_");
    expect(identityWorker).toContain("createIdentityOutboxWorkerProductionComposition");
    expect(identityWorker).toContain("identity.runOneCycle");
    expect(identityWorker).toContain("identity.stopClaiming");
    expect(identityWorker).toContain("identity.returnLeases");
    expect(identityWorker).toContain('loadPlatformDatabaseConfig("identity-worker"');
    expect(client).toContain(
      'internalOperations: Object.freeze(["identity.outbox.consume"] as const)',
    );
    expect(client).toContain('config.role === "identity-worker"');
    expect(compose).toContain("platform-identity-worker:");
    expect(compose).toContain("PLATFORM_IDENTITY_DELIVERY_ENDPOINT");
    expect(compose).toContain("PLATFORM_IDENTITY_DELIVERY_HMAC_SECRET_FILE");
  });

  it("fences resend rotation against an admitted provider dispatch", async () => {
    const repository = await readFile(
      "src/modules/identity/infrastructure/postgres/identity-repository.ts",
      "utf8",
    );
    const service = await readFile(
      "src/modules/identity/application/services/identity-application-service.ts",
      "utf8",
    );
    expect(repository).toMatch(
      /identity_verification_delivery[\s\S]+state IN \('queued','dispatching'\)[\s\S]+FOR UPDATE/u,
    );
    expect(repository).toContain("AND NOT EXISTS (");
    expect(repository).toContain("delivery.state='dispatching'");
    expect(repository).toContain("SET state='superseded'");
    expect(service).toContain("credentialRevision: 0");
    expect(service).toContain("pending.resendCount + 1");
  });

  it("keeps deployable, Kubernetes, and Prisma declarations aligned with the worker runtime", async () => {
    const [deployables, kubernetes, schema] = await Promise.all([
      readFile("deployables.yaml", "utf8"),
      readFile("deploy/k8s/platform-services.example.yaml", "utf8"),
      readFile("prisma/schema.prisma", "utf8"),
    ]);
    expect(deployables).toContain("identity-verification-delivery-https");
    expect(deployables).toContain("id: platform-identity-worker");
    expect(deployables).toContain("credentialClass: platform-identity-worker");
    expect(deployables).toContain("identity-audit-digest-key");
    expect(deployables).toContain("identity-delivery-hmac-key");
    expect(kubernetes).toContain("name: platform-identity-worker");
    expect(kubernetes).toContain("PLATFORM_IDENTITY_SECRET_TRUST_ROOT");
    expect(kubernetes).toContain("runAsNonRoot: true");
    expect(kubernetes).toContain("fsGroup: 1000");
    expect(kubernetes).toContain("defaultMode: 0440");
    expect(schema).toMatch(
      /model IdentityNamespaceAllocationIntent[\s\S]+lastErrorCode\s+String\?\s+@map\("last_error_code"\)/u,
    );
  });
});
