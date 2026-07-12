// MCP 路由错误映射单测（fake 后端即可测：404/500 归口）。真链路见 test/integration/mcp-api.test.ts。

import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { McpServerNotFoundError } from "../../src/domain/errors.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { FakeMcpServerRepository } from "../doubles/fake-mcp-repository.js";
import { FakeSkillRepository } from "../doubles/fake-skill-repository.js";

const mcpRepo = new FakeMcpServerRepository();
const app: FastifyInstance = createHubServer({
  repository: new FakeSkillRepository(),
  mcpRepository: mcpRepo,
  quotaLimits: { maxPackages: 10, maxBytes: 1024 * 1024 },
});

const registerPayload = {
  scope: "ns-a",
  name: "github",
  transport: "http",
  url: "https://mcp.example/github",
  allowed_tools: [],
};

describe("mcp routes error mapping", () => {
  afterAll(async () => {
    await app.close();
  });

  it("maps a McpServerNotFoundError from the toggle to 404", async () => {
    mcpRepo.failNextWith = new McpServerNotFoundError("ns-a", "ghost");
    const response = await app.inject({ method: "POST", url: "/hub/admin/mcp/servers/ns-a/ghost/disable" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("hub.mcp_server_not_found");
  });

  it("maps an unexpected register failure to 500", async () => {
    mcpRepo.failNextWith = new Error("mongo down");
    const response = await app.inject({ method: "POST", url: "/hub/admin/mcp/servers", payload: registerPayload });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("hub.mcp_register_failed");
  });

  it("maps an unexpected toggle failure to 500", async () => {
    mcpRepo.failNextWith = new Error("mongo down");
    const response = await app.inject({ method: "POST", url: "/hub/admin/mcp/servers/ns-a/github/enable" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("hub.mcp_toggle_failed");
  });

  it("maps an unexpected delete failure to 500", async () => {
    mcpRepo.failNextWith = new Error("mongo down");
    const response = await app.inject({ method: "DELETE", url: "/hub/admin/mcp/servers/ns-a/github" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("hub.mcp_delete_failed");
  });

  it("rejects whitespace-only path params on toggle and delete (zod trim guard)", async () => {
    const toggled = await app.inject({ method: "POST", url: "/hub/admin/mcp/servers/%20/github/enable" });
    expect(toggled.statusCode).toBe(400);
    const deleted = await app.inject({ method: "DELETE", url: "/hub/admin/mcp/servers/%20/github" });
    expect(deleted.statusCode).toBe(400);
  });

  it("registers through the service and echoes the stored view", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/mcp/servers",
      payload: { ...registerPayload, secret_ref: "env:GH_MCP_TOKEN" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.server).toMatchObject({ name: "github", secret_ref: "env:GH_MCP_TOKEN" });
  });
});
