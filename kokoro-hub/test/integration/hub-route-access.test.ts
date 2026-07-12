import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import type { MembershipAuthorizer } from "../../src/interfaces/http/membership-authorizer.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, type TestHub } from "./helpers.js";

// hub route-access 负向矩阵（HUB-AUTHZ 三前缀分级）：
// /hub/runtime=runtime-internal（session/agent）、/hub/self=web-bff、/hub/admin=admin。
const SECRETS = {
  session: "sec-session",
  admin: "sec-admin",
  "web-bff": "sec-webbff",
  hub: "sec-hub",
} as const;
const SVC = "x-kokoro-service";
const SEC = "x-kokoro-internal-secret";
// 放行的成员校验器：让 self 面 route-access 结果可观测（不被成员 403 掩盖）。
const allowAll: MembershipAuthorizer = { check: async () => ({ active: true, role: "owner" }) };
const SELF_HEADERS = { "x-kokoro-namespace": "ns-x", "x-kokoro-user-id": "u1" };

let hub: TestHub;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("routeaccess"));
  app = createHubServer({
    repository: new MongoSkillRepository(hub.collections),
    quotaLimits: { maxPackages: 100, maxBytes: 2048 },
    routeAccess: { secrets: SECRETS, isProduction: false },
    membershipAuthorizer: allowAll,
  });
}
const ready = init();

describe("hub route-access 负向矩阵（三面）", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("无 caller 头打 /hub/runtime/skills/pool → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x" });
    expect(res.statusCode).toBe(401);
  });

  it("未知 caller → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x", headers: { [SVC]: "bogus", [SEC]: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("对 caller 错 secret → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x", headers: { [SVC]: "session", [SEC]: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("session 凭据打 /hub/runtime/skills/pool → 过 guard（非 401/403）", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x", headers: { [SVC]: "session", [SEC]: SECRETS.session } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("web-bff 打 /hub/runtime → 403（runtime 面不容 web-bff）", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x", headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("internal.forbidden");
  });

  it("web-bff 凭据打 /hub/self/skills/pool → 过 route-access（非 401/403）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/hub/self/skills/pool",
      headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"], ...SELF_HEADERS },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it("runtime(session) 打 /hub/self → 403（self 面仅 web-bff）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/hub/self/skills/pool",
      headers: { [SVC]: "session", [SEC]: SECRETS.session, ...SELF_HEADERS },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("internal.forbidden");
  });

  it("web-bff 打 /hub/admin/manifest → 403（admin 面仅 admin）", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/admin/manifest", headers: { [SVC]: "web-bff", [SEC]: SECRETS["web-bff"] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("internal.forbidden");
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
