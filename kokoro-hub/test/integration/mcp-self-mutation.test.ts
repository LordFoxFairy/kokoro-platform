import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoMcpSecretRepository } from "../../src/infrastructure/mongo/mongo-mcp-secret-repository.js";
import { MongoMcpServerRepository } from "../../src/infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import type { MembershipAuthorizer, MembershipCheck } from "../../src/interfaces/http/membership-authorizer.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertMcpSecret, testSecretCipher, type TestHub } from "./helpers.js";

// self 面 MCP mutation 门后（KOKORO_HUB_MCP_MUTATION=on）：owner/admin 可注册/启停/软删，
// 但全量强制既有防线——secret_ref 仅本 namespace handle: / URL 预校验拒私网·元数据·env ref。
const NS = "ns-self-mut";
const SELF = { "x-kokoro-namespace": NS, "x-kokoro-user-id": "u1" };
const OWNED_HANDLE = "srt_0123456789abcdef0123456789abcdef";

let hub: TestHub;
let app: FastifyInstance;
let nextCheck: MembershipCheck;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("self-mut"));
  const authorizer: MembershipAuthorizer = { check: async () => nextCheck };
  const cipher = testSecretCipher();
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    mcpRepository: new MongoMcpServerRepository(hub.collections),
    secretRepository: new MongoMcpSecretRepository(hub.collections),
    secretCipher: cipher,
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    membershipAuthorizer: authorizer,
    // 门开启 + 注入解析器：合法 https 主机解析到公网 IP，放行；私网/元数据/字面量仍由网段判定拒绝。
    mcpMutationEnabled: true,
    mcpUrlResolver: async () => ["93.184.216.34"],
  });
}
const ready = init();

async function seedOwnedSecret(): Promise<void> {
  await insertMcpSecret(hub.collections, testSecretCipher(), {
    scope: NS,
    handle: OWNED_HANDLE,
    name: "gh-token",
    value: "example-secret-value",
  });
}

describe("hub self 面 MCP mutation（门后）", () => {
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

  it("owner 注册合法 https server（无凭据）→ 201，revision=1", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: { name: "github", transport: "streamable_http", url: "https://mcp.example.test/gh", allowed_tools: ["search"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.server).toMatchObject({ scope: NS, name: "github", revision: 1, enabled: true });
    // scope 恒取信封头：注册落在本 namespace，不受 body 影响。
    const doc = await hub.collections.mcpServers.findOne({ scope: NS, name: "github" });
    expect(doc?.revision).toBe(1);
  });

  it("member（非 writer）注册 → 403 not_writer", async () => {
    nextCheck = { active: true, role: "member" };
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: { name: "github", transport: "http", url: "https://mcp.example.test/gh", allowed_tools: [] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("hub.forbidden_not_writer");
  });

  it("门后仍拒 env: 凭据引用（self 面仅 handle:）→ 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: {
        name: "github",
        transport: "http",
        url: "https://mcp.example.test/gh",
        allowed_tools: [],
        secret_ref: "env:GH_TOKEN",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });

  it("门后仍拒私网 IP url → 400 mcp_url_forbidden", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: { name: "github", transport: "http", url: "https://10.0.0.1/gh", allowed_tools: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("hub.mcp_url_forbidden");
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });

  it("门后仍拒云元数据地址 169.254.169.254 → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: { name: "github", transport: "http", url: "https://169.254.169.254/latest", allowed_tools: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("hub.mcp_url_forbidden");
  });

  it("门后拒非本 namespace 的 handle 凭据 → 400 secret_ref_unknown", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: {
        name: "github",
        transport: "http",
        url: "https://mcp.example.test/gh",
        allowed_tools: [],
        secret_ref: `handle:${OWNED_HANDLE}`,
      },
    });
    // 未 seed 该 handle → 不属本 namespace → 拒。
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("hub.mcp_secret_ref_unknown");
  });

  it("门后接受本 namespace 的 handle 凭据 → 201", async () => {
    await seedOwnedSecret();
    const res = await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: {
        name: "github",
        transport: "http",
        url: "https://mcp.example.test/gh",
        allowed_tools: [],
        secret_ref: `handle:${OWNED_HANDLE}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.server.secret_ref).toBe(`handle:${OWNED_HANDLE}`);
  });

  it("owner 启停/软删本 namespace server → 200；不存在 enable → 404", async () => {
    await app.inject({
      method: "POST",
      url: "/hub/self/mcp/servers",
      headers: SELF,
      payload: { name: "github", transport: "http", url: "https://mcp.example.test/gh", allowed_tools: [] },
    });
    const disable = await app.inject({ method: "POST", url: "/hub/self/mcp/servers/github/disable", headers: SELF });
    expect(disable.statusCode).toBe(200);
    const del = await app.inject({ method: "DELETE", url: "/hub/self/mcp/servers/github", headers: SELF });
    expect(del.statusCode).toBe(200);
    const ghost = await app.inject({ method: "POST", url: "/hub/self/mcp/servers/ghost/enable", headers: SELF });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe("hub.mcp_server_not_found");
  });
});
