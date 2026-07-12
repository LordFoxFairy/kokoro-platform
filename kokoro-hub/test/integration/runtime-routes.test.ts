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

  it("resolve 聚合 skills + mcp_servers 名称视图 → 200", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });

    const res = await app.inject({ method: "GET", url: "/hub/runtime/resolve", query: { namespace: NS } });

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.skills.map((skill: { name: string }) => skill.name)).toEqual(["writer"]);
    expect(body.mcp_servers).toEqual(["github"]);
  });

  it("resolve 缺 namespace → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/resolve" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });
});
