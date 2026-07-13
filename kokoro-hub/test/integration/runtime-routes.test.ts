import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoMcpServerRepository } from "../../src/infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertMcpServer, insertSkill, type TestHub } from "./helpers.js";

// runtime 面（HUB-AUTHZ）：按已验 namespace 读技能池 + 聚合 resolve（skills + mcp_servers names）。
const NS = "ns-runtime";

let hub: TestHub;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("runtime"));
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    mcpRepository: new MongoMcpServerRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
  });
}
const ready = init();

describe("hub runtime 面（pool + resolve）", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("按 namespace 读技能池 → 200", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool", query: { namespace: NS } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.skills).toEqual([
      { name: "writer", description: "desc-writer", content_hash: "hash-official-writer", scope: "official" },
    ]);
  });

  it("池查询缺 namespace → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });

  it("resolve 聚合 skills + mcp_servers McpGrant[]（含 revision/config_hash）→ 200", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    // 直插的存量文档无 revision：resolve 触发迁移补齐 revision=1 + 快照行。
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });

    const res = await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.skills.map((skill: { name: string }) => skill.name)).toEqual(["writer"]);
    expect(body.mcp_servers).toHaveLength(1);
    const grant = body.mcp_servers[0];
    expect(grant.scope).toBe(NS);
    expect(grant.name).toBe("github");
    expect(grant.revision).toBe(1);
    expect(typeof grant.config_hash).toBe("string");
    expect(grant.config_hash.length).toBe(64);

    // 迁移落地：活文档补上 revision=1，且 append 了一行快照。
    const doc = await hub.collections.mcpServers.findOne({ scope: NS, name: "github" });
    expect(doc?.revision).toBe(1);
    const rows = await hub.collections.mcpServerRevisions.find({ scope: NS, name: "github" }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config_hash).toBe(grant.config_hash);
  });

  it("resolve 缺 namespace → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/resolve" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });

  it("按 (scope,name,revision) 取版本快照 + 活文档现况 → 200", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });
    // 先 resolve 一次触发迁移，落 revision=1 快照行。
    const grantRes = await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });
    const grant = grantRes.json().data.mcp_servers[0];

    const res = await app.inject({
      method: "GET",
      url: `/hub/runtime/mcp/servers/${NS}/github/revisions/1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.snapshot.revision).toBe(1);
    expect(body.snapshot.config_hash).toBe(grant.config_hash);
    expect(body.snapshot.url).toBe(`https://mcp.example/${NS}/github`);
    expect(body.live).toEqual({ enabled: true, deleted: false });
  });

  it("disable 后快照仍在但活文档现况 enabled=false（fail-closed 支撑）", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });
    await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });
    await app.inject({ method: "POST", url: `/hub/admin/mcp/servers/${NS}/github/disable` });

    const res = await app.inject({
      method: "GET",
      url: `/hub/runtime/mcp/servers/${NS}/github/revisions/1`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.snapshot.revision).toBe(1);
    expect(body.live.enabled).toBe(false);
  });

  it("软删后活文档现况 deleted=true（旧会话即刻 fail-closed）", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });
    await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });
    await app.inject({ method: "DELETE", url: `/hub/admin/mcp/servers/${NS}/github` });

    const res = await app.inject({
      method: "GET",
      url: `/hub/runtime/mcp/servers/${NS}/github/revisions/1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.live.deleted).toBe(true);
  });

  it("未知 revision → 404（agent fail-closed 拒装）", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });
    await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });

    const res = await app.inject({
      method: "GET",
      url: `/hub/runtime/mcp/servers/${NS}/github/revisions/99`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("hub.mcp_revision_not_found");
  });
});
