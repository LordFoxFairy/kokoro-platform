import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Model Gateway image effect authority schema", () => {
  it("owns authorization, exact budget fencing, command journal, attempts, observations and evidence", async () => {
    const migration = await readFile(resolve(
      "prisma/migrations/20260810_model_image_effect_vertical/migration.sql",
    ), "utf8");
    for (const table of [
      "model_image_effect_access_authorization",
      "model_image_source_grant_authorization",
      "model_image_option_authorization",
      "model_image_effect_budget_commit",
      "model_image_effect_command_journal",
      "model_image_effect_invocation",
      "model_image_effect_attempt",
      "model_image_effect_provider_observation",
      "model_image_effect_output_evidence",
      "model_image_effect_evidence_ledger",
      "model_image_effect_output_access",
      "model_image_effect_dispatch_queue",
      "model_image_effect_outbox",
    ]) expect(migration).toContain(`CREATE TABLE platform.${table}`);
    expect(migration).toContain("UNIQUE (caller_identity,caller_command_ref)");
    expect(migration).toContain("resolve_model_image_source_grant_authorizations");
    expect(migration).toContain("receipt_ref ~ '^image-effect-receipt:sha256:");
    expect(migration).toContain("UNIQUE (logical_invocation_ref,attempt_ordinal)");
    expect(migration).toContain("effect_budget_commit_ref TEXT NOT NULL UNIQUE");
    expect(migration).toMatch(
      /FOREIGN KEY \(effect_budget_commit_ref,effect_budget_commit_digest,attempt_authorization_ref,[\s\S]+attempt_authorization_digest\) REFERENCES[\s\S]+model_image_effect_budget_commit/u,
    );
    expect(migration).toContain("provider_operation_key TEXT NOT NULL UNIQUE");
    expect(migration).toContain("UNIQUE (attempt_ref,provider_sequence)");
    expect(migration).toContain("UNIQUE (attempt_ref,provider_event_ref)");
    expect(migration).toContain("UNIQUE (logical_invocation_ref,evidence_sequence)");
    expect(migration).toContain("record_model_image_effect_observation");
    expect(migration).toContain("last_evidence_sequence");
    expect(migration).toContain("guard_model_image_effect_evidence_append_only");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("allows an effect only after an atomic exact budget commit and fences leased mutations", async () => {
    const migration = await readFile(resolve(
      "prisma/migrations/20260810_model_image_effect_vertical/migration.sql",
    ), "utf8");
    expect(migration).toContain("consume_model_image_effect_budget_commit");
    expect(migration).toContain("state='verified_available'");
    expect(migration).toContain("state='consumed'");
    expect(migration).toContain("queue.dispatch_fence+1");
    expect(migration).toContain("dispatch_lease_expires_at>statement_timestamp()");
    expect(migration).toContain("guard_model_image_attempt_transition");
    expect(migration).toContain("reject_model_image_owned_delete");
    expect(migration).toContain("model_image_effect_runtime_role_identity");
    expect(migration).toContain("assert_model_image_effect_runtime_role('worker')");
    expect(migration).toContain("SESSION_USER='platform_model_image_worker'");
    expect(migration).toContain("requested_lease_milliseconds NOT BETWEEN 1000 AND 300000");
    expect(migration).toContain("MODEL_IMAGE_EFFECT_ATTEMPT_CLAIM_INCONSISTENT");
    expect(migration).toContain("load_model_image_effect_dispatch_secrets");
    expect(migration).toContain("TO platform_model_image_worker");
    expect(migration).not.toContain("REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC");
  });

  it("keeps Provider bearer decryption behind the fenced dispatch secret loader", async () => {
    const repository = await readFile(resolve(
      "src/modules/model-gateway/infrastructure/postgres/image-effect-postgres.ts",
    ), "utf8");
    const publicAggregateRead = repository.slice(
      repository.indexOf("async lockInvocation("),
      repository.indexOf("async create("),
    );
    expect(publicAggregateRead).not.toContain(".unseal(");
    expect(repository).toContain("class PostgresImageEffectDispatchSecretLoader");
    expect(repository).toContain("plaintext?.fill(0)");
    expect(repository).toContain("sourcePlaintext.fill(0)");
  });
});
