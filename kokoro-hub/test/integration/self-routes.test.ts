import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoMcpServerRepository } from "../../src/infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import type { MembershipAuthorizer, MembershipCheck } from "../../src/interfaces/http/membership-authorizer.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertSkill, type TestHub } from "./helpers.js";

// self 面（HUB-AUTHZ）：scope 恒取信封头 x-kokoro-namespace；成员校验（读=member/写=owner|admin）；
// MCP 只读；MCP mutation 恒 503。route-access 未配 secret=dev 直通，隔离测 self 面授权逻辑本身。
const NS = "ns-self";
const SELF = { "x-kokoro-namespace": NS, "x-kokoro-user-id": "u1" };

let hub: TestHub;
let app: FastifyInstance;
// 可变成员校验结果：每测置 nextCheck 模拟 user /memberships/check 的 {active, role}。
let nextCheck: MembershipCheck;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("self"));
  const authorizer: MembershipAuthorizer = { check: async () => nextCheck };
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    mcpRepository: new MongoMcpServerRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    membershipAuthorizer: authorizer,
  });
}
const ready = init();

describe("hub self 面（成员校验 + MCP fail-closed）", () => {
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

  it("活跃成员读技能池（scope=信封头）→ 200", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    const res = await app.inject({ method: "GET", url: "/hub/self/skills/pool", headers: SELF });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.skills).toEqual([
      { name: "writer", description: "desc-writer", content_hash: "hash-official-writer", scope: "official" },
    ]);
  });

  it("非成员读 → 403 not_member", async () => {
    nextCheck = { active: false, role: null };
    const res = await app.inject({ method: "GET", url: "/hub/self/skills/pool", headers: SELF });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("hub.forbidden_not_member");
  });

  it("member 角色写（enable）→ 403 not_writer（owner/admin 才可写）", async () => {
    nextCheck = { active: true, role: "member" };
    const res = await app.inject({ method: "POST", url: "/hub/self/skills/writer/enable", headers: SELF });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("hub.forbidden_not_writer");
  });

  it("owner 写（enable）→ 200", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    const res = await app.inject({ method: "POST", url: "/hub/self/skills/writer/enable", headers: SELF });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
  });

  it("self 面带 scope 参数 → 400 伪造", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/self/skills/pool?namespace=ns-x", headers: SELF });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("hub.self_scope_forbidden");
  });

  it("缺 namespace 信封头 → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/self/skills/pool", headers: { "x-kokoro-user-id": "u1" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("context.namespace_required");
  });

  it("缺 user-id 信封头 → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/self/skills/pool", headers: { "x-kokoro-namespace": NS } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("context.user_required");
  });

  it("MCP 只读（活跃成员）→ 200", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/self/mcp/servers", headers: SELF });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.servers).toEqual([]);
  });

  it("MCP register mutation → 恒 503 capability_registration_disabled", async () => {
    const res = await app.inject({ method: "POST", url: "/hub/self/mcp/servers", headers: SELF, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("capability_registration_disabled");
  });

  it("MCP enable/disable/delete mutation → 恒 503", async () => {
    const enable = await app.inject({ method: "POST", url: "/hub/self/mcp/servers/github/enable", headers: SELF });
    const disable = await app.inject({ method: "POST", url: "/hub/self/mcp/servers/github/disable", headers: SELF });
    const del = await app.inject({ method: "DELETE", url: "/hub/self/mcp/servers/github", headers: SELF });
    expect(enable.statusCode).toBe(503);
    expect(disable.statusCode).toBe(503);
    expect(del.statusCode).toBe(503);
  });

  it("MCP mutation 恒 503（即使非成员，503 优先于成员校验）", async () => {
    nextCheck = { active: false, role: null };
    const res = await app.inject({ method: "POST", url: "/hub/self/mcp/servers", headers: SELF, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("capability_registration_disabled");
  });
});
