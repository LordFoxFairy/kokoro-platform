import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Identity outbox production authority", () => {
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

  it("gives the worker only the Identity projection reads and exact outcome updates it owns", async () => {
    const migrator = await readFile("src/infrastructure/postgres/migrator.ts", "utf8");
    expect(migrator).toContain(
      "GRANT SELECT(site_ref,transaction_ref,state,resend_count,expires_at) ON TABLE platform.identity_verification_transaction",
    );
    expect(migrator).toContain(
      "GRANT SELECT(event_id,site_ref,transaction_ref,credential_revision,state) ON TABLE platform.identity_verification_delivery",
    );
    expect(migrator).toContain(
      "GRANT SELECT(site_ref,subject_ref,workspace_ref,project_ref,execution_space_ref,execution_namespace,namespace_intent_ref) ON TABLE platform.identity_personal_bootstrap",
    );
    expect(migrator).toContain(
      "GRANT UPDATE(state,attempt_count,delivered_at,failed_at,superseded_at,last_error_code,updated_at) ON TABLE platform.identity_verification_delivery",
    );
    expect(migrator).toContain(
      "GRANT UPDATE(state,updated_at) ON TABLE platform.identity_execution_space",
    );
    expect(migrator).toContain(
      "GRANT UPDATE(state,attempt_count,last_error_code,updated_at) ON TABLE platform.identity_namespace_allocation_intent",
    );
    expect(migrator).not.toMatch(
      /workerRole[\s\S]+GRANT (?:INSERT|DELETE) ON TABLE platform\.identity_/u,
    );
    expect(migrator).toContain('AS "hasIdentityOutboxConsumerAuthority"');
    expect(migrator).toContain(
      "NOT has_column_privilege(runtime_role.rolname, 'platform.identity_verification_transaction', 'secret_digest', 'SELECT')",
    );
  });

  it("wires exact Identity claims and lease return into platform-worker", async () => {
    const worker = await readFile("src/process/worker.ts", "utf8");
    const client = await readFile("src/infrastructure/postgres/client.ts", "utf8");
    const compose = await readFile("deploy/docker-compose.services.yml", "utf8");
    expect(worker).toContain("createIdentityOutboxWorkerProductionComposition");
    expect(worker).toContain("identityOutbox.runOneCycle");
    expect(worker).toContain("identityOutbox.stopClaiming");
    expect(worker).toContain("identityOutbox.returnLeases");
    expect(client).toContain('operation === "identity.outbox.consume"');
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
    expect(deployables).toContain("identity-audit-digest-key");
    expect(deployables).toContain("identity-delivery-hmac-key");
    expect(kubernetes).toContain("PLATFORM_IDENTITY_SECRET_TRUST_ROOT");
    expect(kubernetes).toContain("runAsNonRoot: true");
    expect(kubernetes).toContain("fsGroup: 1000");
    expect(kubernetes).toContain("defaultMode: 0440");
    expect(schema).toMatch(
      /model IdentityNamespaceAllocationIntent[\s\S]+lastErrorCode\s+String\?\s+@map\("last_error_code"\)/u,
    );
  });
});
