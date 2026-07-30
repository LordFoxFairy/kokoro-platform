import { describe, expect, it } from "vitest";
import { PostgresModelGatewayDatabase } from
  "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import { resolvePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

class Client {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  released = false;
  async query(text: string, values: readonly unknown[] = []) {
    this.calls.push({ text, values });
    if (text.includes("resolve_model_gateway_authorization")) return { rows: [{
      modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
      siteId: "site-a",
      executionManifestRef: `execution-manifest:sha256:${"a".repeat(64)}`,
      authorizationSegmentRef: "segment-a",
      authorizedGatewayModel: "chat-primary",
      adapterKind: "litellm",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }
  release() { this.released = true; }
}

describe("Postgres Model Gateway database", () => {
  it("fails startup unless the exact credit usage outbox policy is active", async () => {
    const database = new PostgresModelGatewayDatabase({
      pool: {
        query: async () => ({
          rows: [{
            currentUser: "platform_model_gateway",
            currentDatabase: "kokoro_platform",
            serverMajor: 18,
            databaseOwner: "platform_migrator",
            isSuperuser: false,
            canCreateDatabase: false,
            canCreateRole: false,
            canReplicate: false,
            canBypassRls: false,
            inheritsPrivileges: false,
            hasAnyMembership: false,
            isMigratorMember: false,
            canCreateDatabaseObject: false,
            canUseSchema: true,
            canCreateSchema: false,
            canReadFoundation: true,
            canMutateFoundation: false,
            canExecuteAuthorizationResolver: true,
            canExecuteDispatchScanner: true,
            hasRequiredGatewayWrites: true,
            outboxRlsEnabled: false,
            outboxPolicyNames: [],
          }],
          rowCount: 1,
        }),
        connect: async () => { throw new Error("LISTENER_MUST_NOT_CONNECT"); },
        end: async () => undefined,
      },
      expectedDatabaseUser: "platform_model_gateway",
      expectedDatabaseName: "kokoro_platform",
      migratorDatabaseUser: "platform_migrator",
    });
    await expect(database.connect()).rejects.toThrowError("MODEL_GATEWAY_DATABASE_ROLE_INVALID");
  });

  it("resolves one opaque authorization before setting site-scoped workload context", async () => {
    const client = new Client();
    const database = new PostgresModelGatewayDatabase({
      pool: { connect: async () => client, end: async () => undefined },
      expectedDatabaseUser: "platform_model_gateway",
      expectedDatabaseName: "kokoro_platform",
      migratorDatabaseUser: "platform_migrator",
    });
    const handle = `model-authorization:sha256:${"f".repeat(64)}`;
    const result = await database.execute({
      operation: "prepare",
      modelAuthorizationHandle: handle,
    }, async (transaction, authorization) => {
      expect(authorization).toMatchObject({ siteId: "site-a", authorizedGatewayModel: "chat-primary" });
      await resolvePlatformTransaction(transaction).execute("UPDATE exact_gateway_table SET state=state");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(client.calls.map((call) => call.text)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      expect.stringContaining("resolve_model_gateway_authorization"),
      expect.stringContaining("set_config('app.site_id'"),
      "UPDATE exact_gateway_table SET state=state",
      "COMMIT",
    ]);
    expect(client.calls[1]?.values).toEqual([handle, "prepare"]);
    expect(client.calls[2]?.values).toEqual(["model-gateway.prepare", "site-a"]);
    expect(client.released).toBe(true);
  });

  it("rolls back when authorization is absent and never runs provider work", async () => {
    const client = new Client();
    client.query = async (text: string, values: readonly unknown[] = []) => {
      client.calls.push({ text, values });
      if (text.includes("resolve_model_gateway_authorization")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    };
    const database = new PostgresModelGatewayDatabase({
      pool: { connect: async () => client, end: async () => undefined },
      expectedDatabaseUser: "platform_model_gateway",
      expectedDatabaseName: "kokoro_platform",
      migratorDatabaseUser: "platform_migrator",
    });
    let ran = false;
    await expect(database.execute({
      operation: "prepare",
      modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
    }, async () => { ran = true; }))
      .rejects.toThrowError("MODEL_GATEWAY_AUTHORIZATION_NOT_FOUND");
    expect(ran).toBe(false);
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});
