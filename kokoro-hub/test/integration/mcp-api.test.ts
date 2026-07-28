import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMcpServerRepository } from "../../src/infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertMcpServer, type TestHub } from "./helpers.js";

const NS = "ns-mcp";

let hub: TestHub;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("mcp"));
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    mcpRepository: new MongoMcpServerRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    mcpEnvRefAllowlist: new Set(["GH_MCP_TOKEN"]),
    mcpUrlResolver: async () => ["93.184.216.34"],
  });
}

const ready = init();

describe("hub MCP server registry API (real mongo)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("运营 admin:官方目录 GET + 单参 enable/disable/delete 端到端", async () => {
    await insertMcpServer(hub.collections, { scope: "official", name: "github", enabled: true });
    await insertMcpServer(hub.collections, { scope: "official", name: "slack", enabled: false });
    // 租户自有 server 不进运营官方目录。
    await insertMcpServer(hub.collections, { scope: NS, name: "mine", enabled: true });

    // 目录 GET:data 直包数组(对齐通用网关信封),含禁用项 + 全字段,只出 official。
    const list = await app.inject({ method: "GET", url: "/hub/admin/official/mcp/servers" });
    expect(list.statusCode).toBe(200);
    const cards = list.json().data as { scope: string; name: string; enabled: boolean }[];
    expect(cards.map((c) => c.name)).toEqual(["github", "slack"]);
    expect(cards.every((c) => c.scope === "official")).toBe(true);
    expect(cards.find((c) => c.name === "slack")?.enabled).toBe(false);

    // 单参 disable(scope=official 隐含)。
    const disable = await app.inject({ method: "POST", url: "/hub/admin/official/mcp/servers/github/disable" });
    expect(disable.statusCode).toBe(200);
    // 单参 enable 复活 slack。
    const enable = await app.inject({ method: "POST", url: "/hub/admin/official/mcp/servers/slack/enable" });
    expect(enable.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/hub/admin/official/mcp/servers" })).json().data as {
      name: string;
      enabled: boolean;
    }[];
    expect(after.find((c) => c.name === "github")?.enabled).toBe(false);
    expect(after.find((c) => c.name === "slack")?.enabled).toBe(true);

    // 单参软删 → 离目录。
    const del = await app.inject({ method: "DELETE", url: "/hub/admin/official/mcp/servers/github" });
    expect(del.statusCode).toBe(200);
    const final = (await app.inject({ method: "GET", url: "/hub/admin/official/mcp/servers" })).json().data as {
      name: string;
    }[];
    expect(final.map((c) => c.name)).toEqual(["slack"]);
  });

  it("单参 enable/disable 目标不存在 → 404", async () => {
    const missing = await app.inject({ method: "POST", url: "/hub/admin/official/mcp/servers/ghost/enable" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("hub.mcp_server_not_found");
  });

  it("registers a server and returns the stored view", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      headers: { "x-kokoro-request-id": "req_mcp_reg" },
      payload: {
        scope: NS,
        name: "github",
        transport: "streamable_http",
        url: "https://mcp.example/github",
        allowed_tools: ["search_issues", "create_issue"],
        secret_ref: "env:GH_MCP_TOKEN",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.requestId).toBe("req_mcp_reg");
    expect(body.data.server).toEqual({
      scope: NS,
      name: "github",
      revision: 1,
      transport: "streamable_http",
      url: "https://mcp.example/github",
      allowed_tools: ["search_issues", "create_issue"],
      secret_ref: "env:GH_MCP_TOKEN",
      enabled: true,
    });

    const doc = await hub.collections.mcpServers.findOne({ scope: NS, name: "github" });
    expect(doc).toMatchObject({ enabled: true, deleted_at: null, secret_ref: "env:GH_MCP_TOKEN" });
  });

  it("re-registering updates the definition without flipping the enabled toggle", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github", enabled: false });

    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: {
        scope: NS,
        name: "github",
        transport: "http",
        url: "https://mcp.example/github-v2",
        allowed_tools: [],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.server).toMatchObject({
      url: "https://mcp.example/github-v2",
      transport: "http",
      enabled: false, // 重注册不翻用户启停位
    });
  });

  it("merges official and namespace servers with the namespace overriding a same name", async () => {
    await insertMcpServer(hub.collections, {
      scope: "official",
      name: "github",
      url: "https://mcp.example/official/github",
    });
    await insertMcpServer(hub.collections, { scope: "official", name: "search" });
    await insertMcpServer(hub.collections, {
      scope: NS,
      name: "github",
      url: "https://mcp.example/mine/github",
    });

    const response = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers", query: { namespace: NS } });

    expect(response.statusCode).toBe(200);
    const servers = response.json().data.servers;
    expect(servers.map((server: { scope: string; name: string }) => [server.scope, server.name])).toEqual([
      [NS, "github"],
      ["official", "search"],
    ]);
    expect(servers[0].url).toBe("https://mcp.example/mine/github");
  });

  it("keeps a disabled own server out of the pool without falling back to the official one", async () => {
    await insertMcpServer(hub.collections, { scope: "official", name: "github" });
    await insertMcpServer(hub.collections, { scope: NS, name: "github", enabled: false });

    const response = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers", query: { namespace: NS } });
    expect(response.json().data.servers).toEqual([]);
  });

  it("rejects a pool query without a namespace", async () => {
    const response = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("disables and re-enables a server via the toggle routes", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });

    const disabled = await app.inject({ method: "POST", url: `/hub/admin/mcp/servers/${NS}/github/disable` });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data).toEqual({ ok: true });

    let pool = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers", query: { namespace: NS } });
    expect(pool.json().data.servers).toEqual([]);

    const enabled = await app.inject({ method: "POST", url: `/hub/admin/mcp/servers/${NS}/github/enable` });
    expect(enabled.statusCode).toBe(200);

    pool = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers", query: { namespace: NS } });
    expect(pool.json().data.servers).toHaveLength(1);
  });

  it("returns 404 when toggling a server that does not exist", async () => {
    const response = await app.inject({ method: "POST", url: `/hub/admin/mcp/servers/${NS}/ghost/enable` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("hub.mcp_server_not_found");
  });

  it("soft deletes a server and lets a re-registration revive it", async () => {
    await insertMcpServer(hub.collections, { scope: NS, name: "github" });

    const deleted = await app.inject({ method: "DELETE", url: `/hub/admin/mcp/servers/${NS}/github` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toEqual({ ok: true });

    const pool = await app.inject({ method: "GET", url: "/hub/admin/mcp/servers", query: { namespace: NS } });
    expect(pool.json().data.servers).toEqual([]);

    const revived = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: { scope: NS, name: "github", transport: "http", url: "https://mcp.example/github", allowed_tools: [] },
    });
    expect(revived.statusCode).toBe(201);

    const doc = await hub.collections.mcpServers.findOne({ scope: NS, name: "github" });
    expect(doc?.deleted_at).toBeNull();
  });

  // --- 负向：注册守门（明文凭据 / 坏 url / 未知 transport）---

  it("rejects a plaintext credential in secret_ref", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: {
        scope: NS,
        name: "github",
        transport: "http",
        url: "https://mcp.example/github",
        allowed_tools: [],
        secret_ref: "example-plaintext-token-value",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });

  it("rejects a url that embeds credentials (userinfo is a plaintext channel)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: {
        scope: NS,
        name: "github",
        transport: "http",
        url: "https://user:example-password@mcp.example/github",
        allowed_tools: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });

  it("rejects a malformed or non-http url", async () => {
    for (const url of ["not-a-url", "ftp://mcp.example/github"]) {
      const response = await app.inject({
        method: "POST",
        url: "/hub/admin/mcp/servers",
        payload: { scope: NS, name: "github", transport: "http", url, allowed_tools: [] },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });

  it("rejects an unknown transport", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: {
        scope: NS,
        name: "github",
        transport: "websocket",
        url: "https://mcp.example/github",
        allowed_tools: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await hub.collections.mcpServers.countDocuments({})).toBe(0);
  });
});
