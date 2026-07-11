import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertSkill, type TestHub } from "./helpers.js";

const NS = "ns-http";

let hub: TestHub;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("api"));
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
  });
}

const ready = init();

describe("hub HTTP API (real mongo)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("returns module health", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { module: "hub", status: "ok" } });
  });

  it("exposes the admin manifest", async () => {
    const response = await app.inject({ method: "GET", url: "/hub/admin/manifest" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: "kokoro-hub", basePath: "/hub/admin" });
  });

  it("lists the pool for a namespace", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    const response = await app.inject({
      method: "GET",
      url: "/hub/skills/pool",
      query: { namespace: NS },
      headers: { "x-kokoro-request-id": "req_pool" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe("req_pool");
    expect(body.data.skills).toEqual([
      { name: "writer", description: "desc-writer", content_hash: "hash-official-writer", scope: "official" },
    ]);
  });

  it("rejects a pool query without a namespace", async () => {
    const response = await app.inject({ method: "GET", url: "/hub/skills/pool" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("disables an official skill so it drops out of the pool", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    const disabled = await app.inject({
      method: "POST",
      url: "/hub/skills/official/writer/disable",
      payload: { namespace: NS },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data).toEqual({ ok: true });

    const pool = await app.inject({ method: "GET", url: "/hub/skills/pool", query: { namespace: NS } });
    expect(pool.json().data.skills).toEqual([]);
  });

  it("returns 409 when disabling a required official skill", async () => {
    await insertSkill(hub.collections, {
      scope: "official",
      name: "guard",
      official_required: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/official/guard/disable",
      payload: { namespace: NS },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("hub.skill_required");
  });

  it("sets official flags", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/writer/official-flags",
      payload: { required: true },
    });
    expect(response.statusCode).toBe(200);

    // now required: a disable attempt is rejected
    const disabled = await app.inject({
      method: "POST",
      url: "/hub/skills/official/writer/disable",
      payload: { namespace: NS },
    });
    expect(disabled.statusCode).toBe(409);
  });

  it("rejects an empty official-flags body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/writer/official-flags",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it("soft deletes a skill", async () => {
    await insertSkill(hub.collections, { scope: NS, name: "mine" });

    const deleted = await app.inject({ method: "DELETE", url: `/hub/skills/${NS}/mine` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data).toEqual({ ok: true });

    const pool = await app.inject({ method: "GET", url: "/hub/skills/pool", query: { namespace: NS } });
    expect(pool.json().data.skills).toEqual([]);
  });

  it("reports the quota view with env limits", async () => {
    await insertSkill(hub.collections, { scope: NS, name: "one", package_size: 100 });
    await insertSkill(hub.collections, { scope: NS, name: "two", package_size: 250 });

    const response = await app.inject({ method: "GET", url: "/hub/skills/quota", query: { namespace: NS } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      namespace: NS,
      package_count: 2,
      package_bytes: 350,
      max_packages: 100,
      max_bytes: 2048,
    });
  });
});
