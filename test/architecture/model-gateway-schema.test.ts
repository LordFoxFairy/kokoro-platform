import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const originalMigrationPath =
  "prisma/migrations/20260802_1200_model_gateway_attempt_producer/migration.sql";
const dispatchAuthorityMigrationPath =
  "prisma/migrations/20260826_model_gateway_dispatch_authority_fence/migration.sql";

describe("Model Gateway owned schema", () => {
  it("keeps opaque authorization, invocation, encrypted response, usage fact and outbox durable", async () => {
    const migration = await readFile(resolve(
      "prisma/migrations/20260802_1200_model_gateway_attempt_producer/migration.sql",
    ), "utf8");

    for (const table of [
      "model_gateway_execution_authorization",
      "model_gateway_invocation",
      "model_gateway_attempt_usage_fact",
      "model_gateway_outbox",
    ]) expect(migration).toContain(`CREATE TABLE platform.${table}`);
    expect(migration).toContain("response_envelope JSONB");
    expect(migration).not.toContain("response_body");
    expect(migration).toContain("CREATE FUNCTION platform.resolve_model_gateway_authorization");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("guard_model_gateway_invocation_transition");
    expect(migration).toContain("NEW.dispatch_fence<>OLD.dispatch_fence+1");
    expect(migration).toContain("CREATE TABLE platform.model_gateway_frame");
    expect(migration).toContain("CREATE TABLE platform.model_gateway_capacity");
    expect(migration).toContain("list_model_gateway_dispatch_candidates");
    expect(migration).toContain("guard_model_gateway_authorization_transition");
    expect(migration).toContain("reject_model_gateway_owned_delete");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.resolve_model_gateway_authorization(TEXT,TEXT) FROM PUBLIC");
  });

  it("uses its owned outbox without generic Platform outbox authority", async () => {
    const [migrator, database] = await Promise.all([
      readFile(resolve("src/infrastructure/postgres/migrator.ts"), "utf8"),
      readFile(resolve(
        "src/modules/model-gateway/infrastructure/postgres/model-gateway-database.ts",
      ), "utf8"),
    ]);

    expect(migrator).toContain("GRANT SELECT,INSERT ON TABLE platform.model_gateway_outbox TO ${gateway}");
    expect(migrator).not.toContain("GRANT INSERT ON TABLE platform.outbox_event TO ${gateway}");
    expect(migrator).toContain("NOT has_table_privilege($1,'platform.outbox_event','SELECT')");
    expect(migrator).toContain("NOT has_table_privilege($1,'platform.outbox_event','INSERT')");
    expect(database).toContain("NOT has_table_privilege(current_user,'platform.outbox_event','SELECT')");
    expect(database).toContain("NOT has_table_privilege(current_user,'platform.outbox_event','INSERT')");
  });

  it("keeps the applied Model Gateway migration immutable and upgrades its dispatch guard forward", async () => {
    const original = await readFile(resolve(originalMigrationPath), "utf8");
    const forward = await readFile(resolve(dispatchAuthorityMigrationPath), "utf8");

    expect(createHash("sha256").update(original).digest("hex")).toBe(
      "433986e052f232d9fa50139484085a3975a0c1a024d91ee8f8f9e26e16ed9749",
    );
    expect(original).not.toContain("MODEL_GATEWAY_INVOCATION_DISPATCH_AUTHORITY_INVALID");
    expect(forward).toContain(
      "CREATE OR REPLACE FUNCTION platform.guard_model_gateway_invocation_transition()",
    );
    expect(forward).toContain("SET search_path = pg_catalog, platform");
    expect(forward).toContain(
      "REVOKE ALL ON FUNCTION platform.guard_model_gateway_invocation_transition() FROM PUBLIC",
    );
    expect(forward).toContain("NEW.dispatch_owner_ref IS DISTINCT FROM OLD.dispatch_owner_ref");
    expect(forward).toContain("NEW.dispatch_fence IS DISTINCT FROM OLD.dispatch_fence");
    expect(forward).toContain(
      "OLD.state IN ('dispatching','succeeded','failed','outcome_unknown') AND (",
    );
    expect(forward).not.toContain("OLD.dispatch_fence>0 AND (");
    expect(forward).toContain("NEW.dispatch_lease_expires_at<OLD.dispatch_lease_expires_at");
    expect(forward).toContain("MODEL_GATEWAY_INVOCATION_DISPATCH_AUTHORITY_INVALID");
    expect(forward).toContain("NEW.dispatch_fence<>OLD.dispatch_fence+1");
    expect(forward).toContain("MODEL_GATEWAY_INVOCATION_IDENTITY_IMMUTABLE");
    expect(forward).toContain("OLD.state IN ('succeeded','failed','outcome_unknown')");
    for (const column of [
      "response_envelope",
      "evidence_ref",
      "source_digest",
      "owner_evidence_ref",
      "fence_epoch",
      "dispatch_owner_ref",
      "dispatch_fence",
      "dispatch_lease_expires_at",
    ]) {
      expect(forward).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(forward).toContain("MODEL_GATEWAY_INVOCATION_TERMINAL_IMMUTABLE");
    expect(forward).toContain("NEW.last_frame_sequence<>OLD.last_frame_sequence+1");
    expect(forward).toContain("NEW.frame_count<>OLD.frame_count+1");
    expect(forward).toContain("NEW.total_frame_bytes<=OLD.total_frame_bytes");
    expect(forward).toContain("NEW.last_frame_digest IS NOT DISTINCT FROM OLD.last_frame_digest");
    expect(forward).toContain("MODEL_GATEWAY_INVOCATION_TERMINAL_FRAME_INVALID");
    expect(forward).toContain(
      "CREATE UNIQUE INDEX model_gateway_frame_one_terminal_idx",
    );
    expect(forward).toContain(
      "ON platform.model_gateway_frame(site_ref,invocation_ref) WHERE terminal",
    );
  });
});
