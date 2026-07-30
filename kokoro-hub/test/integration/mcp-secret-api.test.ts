import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMcpSecretRepository } from "../../src/infrastructure/mongo/mongo-mcp-secret-repository.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import type { MembershipAuthorizer, MembershipCheck } from "../../src/interfaces/http/membership-authorizer.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, testSecretCipher, type TestHub } from "./helpers.js";

// secret broker HTTP 面仅提供 self CRUD（成员校验）；运行时明文只从 mTLS
// ResolveExecutionAssembly 返回给 Agent，本测试不重复覆盖 ConnectRPC 装配面。
const NS = "ns-secret";
const OTHER_NS = "ns-other";
const SELF = { "x-kokoro-namespace": NS, "x-kokoro-user-id": "u1" };

let hub: TestHub;
let app: FastifyInstance;
let nextCheck: MembershipCheck;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("secret"));
  const authorizer: MembershipAuthorizer = { check: async () => nextCheck };
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    secretRepository: new MongoMcpSecretRepository(hub.collections),
    secretCipher: testSecretCipher(),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    membershipAuthorizer: authorizer,
  });
}
const ready = init();

async function createSecret(name: string, value: string, headers = SELF): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/hub/self/mcp/secrets", headers, payload: { name, value } });
  expect(res.statusCode).toBe(201);
  return res.json().data.handle;
}

describe("hub MCP secret broker (real mongo + real cipher)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
    nextCheck = { active: true, role: "owner" };
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("stores a secret and returns only an opaque handle (value never echoed)", async () => {
    const secretValue = "plaintext-marker-abc123";
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/secrets",
      headers: SELF,
      payload: { name: "github-token", value: secretValue },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.handle).toMatch(/^srt_[0-9a-f]{32}$/);
    // 明文只进不出：创建响应绝不含 value。
    expect(res.body).not.toContain(secretValue);

    // 落库是密文信封 + key_id，绝无明文字段。
    const doc = await hub.collections.mcpSecrets.findOne({ scope: NS });
    expect(doc?.ciphertext.startsWith("v1:")).toBe(true);
    expect(doc?.key_id).toBeTruthy();
    expect(JSON.stringify(doc)).not.toContain(secretValue);
  });

  it("lists secrets with handle/name/created only — never the value or ciphertext", async () => {
    const secretValue = "list-marker-should-not-leak";
    await createSecret("token-a", secretValue);
    const res = await app.inject({ method: "GET", url: "/hub/self/mcp/secrets", headers: SELF });
    expect(res.statusCode).toBe(200);
    const secrets = res.json().data.secrets;
    expect(secrets).toHaveLength(1);
    expect(Object.keys(secrets[0]).sort()).toEqual(["createdAt", "handle", "name"]);
    expect(res.body).not.toContain(secretValue);
    expect(res.body).not.toContain("ciphertext");
  });

  it("soft-deletes a secret idempotently and drops it from the pool", async () => {
    const handle = await createSecret("token-b", "delete-me");
    const first = await app.inject({ method: "DELETE", url: `/hub/self/mcp/secrets/${handle}`, headers: SELF });
    expect(first.statusCode).toBe(200);
    // 幂等：再删仍 200。
    const second = await app.inject({ method: "DELETE", url: `/hub/self/mcp/secrets/${handle}`, headers: SELF });
    expect(second.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/hub/self/mcp/secrets", headers: SELF });
    expect(list.json().data.secrets).toEqual([]);
  });

  it("enforces membership: read=member, write=owner/admin", async () => {
    nextCheck = { active: false, role: null };
    const nonMember = await app.inject({ method: "GET", url: "/hub/self/mcp/secrets", headers: SELF });
    expect(nonMember.statusCode).toBe(403);
    expect(nonMember.json().error.code).toBe("hub.forbidden_not_member");

    nextCheck = { active: true, role: "member" };
    const memberWrite = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/secrets",
      headers: SELF,
      payload: { name: "n", value: "v" },
    });
    expect(memberWrite.statusCode).toBe(403);
    expect(memberWrite.json().error.code).toBe("hub.forbidden_not_writer");
  });

  it("rejects a scope smuggled into the self create body (strict)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/secrets",
      headers: SELF,
      payload: { name: "n", value: "v", scope: OTHER_NS },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });

  it("never leaks plaintext across the self surface", async () => {
    const secretValue = "no-leak-across-surface-xyz";
    const handle = await createSecret("token-g", secretValue);
    const surfaces = [
      await app.inject({ method: "GET", url: "/hub/self/mcp/secrets", headers: SELF }),
      await app.inject({ method: "DELETE", url: `/hub/self/mcp/secrets/${handle}`, headers: SELF }),
    ];
    for (const res of surfaces) {
      expect(res.body).not.toContain(secretValue);
    }
  });
});

describe("hub MCP secret broker disabled (no cipher configured)", () => {
  let disabledHub: TestHub;
  let disabledApp: FastifyInstance;

  const setup = (async () => {
    disabledHub = await connectTestHub(hubTestDbName("secret_disabled"));
    disabledApp = createHubServer({
      repository: new MongoSkillRepository(disabledHub.collections),
      // 不注入 secretRepository/secretCipher → secret broker 未配置。
      quotaLimits: { maxPackages: 100, maxBytes: 2048 },
      membershipAuthorizer: { check: async () => ({ active: true, role: "owner" }) },
    });
  })();

  afterAll(async () => {
    await disabledApp.close();
    await disabledHub.dropDatabase();
    await disabledHub.client.close();
  });

  it("returns 503 secret_broker_disabled on the self secret face", async () => {
    await setup;
    const create = await disabledApp.inject({
      method: "POST",
      url: "/hub/self/mcp/secrets",
      headers: SELF,
      payload: { name: "n", value: "v" },
    });
    expect(create.statusCode).toBe(503);
    expect(create.json().error.code).toBe("secret_broker_disabled");
  });
});
