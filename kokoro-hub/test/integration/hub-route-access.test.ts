import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import type { MembershipAuthorizer } from "../../src/interfaces/http/membership-authorizer.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, type TestHub } from "./helpers.js";

// Hub HTTP 负向矩阵：/hub/self=web-bff、/hub/admin=admin。
// 运行时装配仅通过 mTLS ConnectRPC 暴露，旧 /hub/runtime 不再存在。
const SECRETS = {
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

describe("hub HTTP route-access 负向矩阵", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("旧 /hub/runtime 不再存在", async () => {
    const res = await app.inject({ method: "GET", url: "/hub/runtime/skills/pool?namespace=ns-x" });
    expect(res.statusCode).toBe(404);
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

  it("admin 打 /hub/self → 403（self 面仅 web-bff）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/hub/self/skills/pool",
      headers: { [SVC]: "admin", [SEC]: SECRETS.admin, ...SELF_HEADERS },
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
