import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(migration).toContain("NEW.fence_epoch <> OLD.fence_epoch+1");
    expect(migration).toContain("guard_model_gateway_authorization_transition");
    expect(migration).toContain("reject_model_gateway_owned_delete");
    expect(migration).toContain("REVOKE ALL ON FUNCTION platform.resolve_model_gateway_authorization(TEXT,TEXT) FROM PUBLIC");
  });
});
