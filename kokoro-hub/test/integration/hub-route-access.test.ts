import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, type TestHub } from "./helpers.js";

// hub route-access 负向矩阵（TRUST-ROUTES 验收）：hub 原本无内部鉴权，本项归 runtime-internal 堵缺口；
// self-service(web-bff) 三面细分留待 HUB-AUTHZ，故 web-bff 现为 fail-closed(403)。
const SECRETS = { session: "sec-session", admin: "sec-admin", "web-bff": "sec-webbff" } as const;
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";

let hub: TestHub;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("routeaccess"));
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    routeAccess: { secrets: SECRETS, isProduction: false },
  });
}
const ready = init();

describe("hub route-access 负向矩阵", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("无 caller 头打 /hub/skills/pool → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/skills/pool?scope=ns-x" });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/skills/pool?scope=ns-x", headers: { [SVC]: "bogus", [SEC]: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/skills/pool?scope=ns-x", headers: { [SVC]: "session", [SEC]: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("web-bff 凭据打 /hub → 403（self-service 未开，fail-closed）", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/skills/pool?scope=ns-x", headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] } });
    expect(res.statusCode).toBe(403);
  });

  it("session 凭据打 /hub/skills/pool → 过 guard（非 401/403）", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/skills/pool?scope=ns-x", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("admin 凭据打 /hub/admin/manifest → 200", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/admin/manifest", headers: { [SVC]: "admin", [SEC]: SECRETS.admin } });
    expect(res.statusCode).toBe(200);
  });

  it("/healthz 公开 → 无凭据放行", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });
});
