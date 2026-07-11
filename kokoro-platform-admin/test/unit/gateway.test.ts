import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleConfig } from "../../src/config.js";
import { createAdminServer, type AdminServerDeps } from "../../src/server.js";
import {
  executeAction,
  GatewayError,
  getManifests,
  getSites,
  getUser360,
  prepareAction,
  proxyAction,
  proxyResource,
  type AuditEntry,
  type AuditSink,
} from "../../src/gateway.js";
import type { Operator } from "../../src/rbac.js";

const SUPER: Operator = { id: "op_super", email: "admin@kokoro.local", roleKey: "superadmin", permissions: ["*"], scopeSites: ["*"] };
const FINANCE: Operator = { id: "op_fin", email: "fin@kokoro.local", roleKey: "finance", permissions: ["payment.*", "credit.grant"], scopeSites: ["site_1"] };
const TENANT: Operator = { id: "op_t", email: "t@kokoro.local", roleKey: "support", permissions: ["user.disable"], scopeSites: ["site_2"] };
const CREDIT_READER: Operator = { id: "op_credit", email: "credit@kokoro.local", roleKey: "support", permissions: ["credit.account.read"], scopeSites: ["site_1"] };

const modules: ModuleConfig[] = [
  { id: "credit", label: "Credits", baseUrl: "http://127.0.0.1:4231", manifestPath: "/admin/credits/manifest" },
  { id: "user", label: "Users", baseUrl: "http://127.0.0.1:4211", manifestPath: "/admin/users/manifest" },
];

const creditManifest = {
  id: "kokoro-credit",
  labelKey: "admin.modules.credit",
  basePath: "/admin/credits",
  requiredPermission: "credit.admin",
  navItems: [],
  resources: [
    {
      id: "accounts",
      labelKey: "admin.credit.resources.accounts",
      route: "/admin/credits/accounts",
      requiredPermission: "credit.account.read",
      actions: [],
    },
  ],
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getManifests", () => {
  it("aggregates online manifests parsed from the {data} envelope", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/admin/credits/manifest")) return jsonResponse({ data: creditManifest });
      return jsonResponse({ data: { ...creditManifest, id: "kokoro-user", basePath: "/admin/users" } });
    });

    const result = await getManifests(modules);
    expect(result).toHaveLength(2);
    const credit = result.find((m) => m.id === "credit");
    expect(credit?.online).toBe(true);
    if (credit?.online) {
      expect(credit.manifest.resources[0]?.route).toBe("/admin/credits/accounts");
    }
  });

  it("degrades to an offline item without throwing when a module is unreachable", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/admin/credits/manifest")) throw new Error("ECONNREFUSED");
      return jsonResponse({ data: creditManifest });
    });

    const result = await getManifests(modules);
    const credit = result.find((m) => m.id === "credit");
    expect(credit?.online).toBe(false);
    if (credit && !credit.online) {
      expect(credit.error).toContain("ECONNREFUSED");
    }
  });

  it("marks a module offline on a non-2xx manifest response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 503));
    const result = await getManifests(modules);
    expect(result.every((m) => m.online === false)).toBe(true);
  });
});

describe("proxyResource", () => {
  it("proxies a route that the manifest declares and unwraps the {data} array", async () => {
    const rows = [{ id: "acc_1", balance: 100 }];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/manifest")) return jsonResponse({ data: creditManifest });
      return jsonResponse({ data: rows });
    });

    const result = await proxyResource(modules, "credit", "/admin/credits/accounts");
    expect(result).toEqual(rows);
  });

  it("rejects a route absent from the manifest (anti open-proxy/SSRF)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: creditManifest }));
    await expect(proxyResource(modules, "credit", "/etc/passwd")).rejects.toBeInstanceOf(GatewayError);
    await expect(proxyResource(modules, "credit", "/etc/passwd")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects an unknown module id", async () => {
    await expect(proxyResource(modules, "nope", "/admin/credits/accounts")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a 502 when the target module is offline", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(proxyResource(modules, "credit", "/admin/credits/accounts")).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("enforces the resource requiredPermission when an operator is supplied (no anonymous proxy)", async () => {
    const manifestThenRows = async (input: string | URL | Request): Promise<Response> =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({ data: [{ id: "acc_1" }] });

    fetchMock.mockImplementation(manifestThenRows);
    await expect(proxyResource(modules, "credit", "/admin/credits/accounts", SUPER)).resolves.toEqual([
      { id: "acc_1" },
    ]);

    fetchMock.mockReset();
    fetchMock.mockImplementation(manifestThenRows);
    // TENANT holds only user.disable, not credit.account.read → 403 before any upstream call.
    await expect(
      proxyResource(modules, "credit", "/admin/credits/accounts", TENANT),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/manifest"))).toBe(true);
  });

  it("returns every declared row for a super-scoped operator when no siteId is requested", async () => {
    const rows = [
      { id: "acc_1", siteId: "site_1" },
      { id: "acc_2", siteId: "site_2" },
      { id: "acc_global" },
    ];
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest") ? jsonResponse({ data: creditManifest }) : jsonResponse({ data: rows }),
    );

    await expect(
      proxyResource(modules, "credit", "/admin/credits/accounts", { operator: SUPER }),
    ).resolves.toEqual(rows);
  });

  it("filters resource rows to the operator tenant scope and drops rows without siteId", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({
            data: [
              { id: "acc_1", siteId: "site_1" },
              { id: "acc_2", siteId: "site_2" },
              { id: "acc_global" },
            ],
          }),
    );

    await expect(
      proxyResource(modules, "credit", "/admin/credits/accounts", { operator: CREDIT_READER }),
    ).resolves.toEqual([{ id: "acc_1", siteId: "site_1" }]);
  });

  it("honors an in-scope requested siteId", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({
            data: [
              { id: "acc_1", siteId: "site_1" },
              { id: "acc_2", siteId: "site_2" },
            ],
          }),
    );

    await expect(
      proxyResource(modules, "credit", "/admin/credits/accounts", { operator: CREDIT_READER, siteId: "site_1" }),
    ).resolves.toEqual([{ id: "acc_1", siteId: "site_1" }]);
  });

  it("rejects an out-of-scope requested siteId before fetching the upstream resource route", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({ data: [{ id: "acc_2", siteId: "site_2" }] }),
    );

    await expect(
      proxyResource(modules, "credit", "/admin/credits/accounts", { operator: CREDIT_READER, siteId: "site_2" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/manifest");
  });
});

function buildServerDeps(operator: Operator): AdminServerDeps {
  return {
    audit: { record: async () => {} },
    resolveOperator: async () => operator,
    authenticate: async () => operator.email,
    prisma: {} as AdminServerDeps["prisma"],
    approvalGrantThresholdMicros: 100_000_000n,
  };
}

describe("/api/resource", () => {
  it("passes the requested siteId into the service-side resource scope filter", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({
            data: [
              { id: "acc_1", siteId: "site_1" },
              { id: "acc_2", siteId: "site_2" },
            ],
          }),
    );
    const app = createAdminServer(modules, buildServerDeps(CREDIT_READER));

    const res = await app.inject({
      method: "GET",
      url: "/api/resource?moduleId=credit&route=%2Fadmin%2Fcredits%2Faccounts&siteId=site_1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: "acc_1", siteId: "site_1" }]);
  });

  it("rejects out-of-scope site reads through the HTTP route", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input).includes("/manifest")
        ? jsonResponse({ data: creditManifest })
        : jsonResponse({ data: [{ id: "acc_2", siteId: "site_2" }] }),
    );
    const app = createAdminServer(modules, buildServerDeps(CREDIT_READER));

    const res = await app.inject({
      method: "GET",
      url: "/api/resource?moduleId=credit&route=%2Fadmin%2Fcredits%2Faccounts&siteId=site_2",
    });

    expect(res.statusCode).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/manifest");
  });
});

const userActionManifest = {
  id: "kokoro-user",
  labelKey: "admin.modules.user",
  basePath: "/admin/users",
  requiredPermission: "user.admin",
  navItems: [],
  resources: [
    {
      id: "users",
      labelKey: "admin.user.resources.users",
      route: "/admin/users",
      requiredPermission: "user.read",
      actions: [
        {
          id: "disable",
          labelKey: "admin.user.actions.disable",
          kind: "dangerMutation",
          requiredPermission: "user.disable",
          route: "/admin/users/:id/disable",
          method: "POST",
        },
      ],
    },
  ],
};

class RecordingSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

describe("proxyAction", () => {
  it("proxies a declared action, substitutes :param, forwards siteId, records an ok audit", async () => {
    const sink = new RecordingSink();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/manifest")) return jsonResponse({ data: userActionManifest });
      return jsonResponse({ data: { id: "u_1", status: "disabled" } });
    });

    const result = await proxyAction(
      modules,
      sink,
      { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" }, siteId: "site_1", reason: "TOS" },
      "req_1",
      SUPER,
    );

    expect(result).toEqual({ id: "u_1", status: "disabled" });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/disable"));
    expect(String(call?.[0])).toContain("/admin/users/u_1/disable");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-kokoro-site-id"]).toBe("site_1");
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({ result: "ok", statusCode: 200, targetRoute: "/admin/users/u_1/disable", actorEmail: "admin@kokoro.local" });
  });

  it("forwards DELETE when declared by the action manifest", async () => {
    const sink = new RecordingSink();
    const deleteManifest = {
      ...userActionManifest,
      resources: [
        {
          ...userActionManifest.resources[0],
          actions: [
            {
              id: "delete",
              labelKey: "admin.user.actions.delete",
              kind: "dangerMutation",
              requiredPermission: "user.disable",
              route: "/admin/users/:id",
              method: "DELETE",
            },
          ],
        },
      ],
    };
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/manifest")) return jsonResponse({ data: deleteManifest });
      return jsonResponse({ data: { id: "u_1", deletedAt: "2026-07-02T00:00:00.000Z" } });
    });

    await proxyAction(
      modules,
      sink,
      { moduleId: "user", resourceId: "users", actionId: "delete", params: { id: "u_1" }, reason: "cleanup" },
      "req_1",
      SUPER,
    );

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/admin/users/u_1"));
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("DELETE");
  });

  it("denies an operator lacking the action permission and records a 403 audit", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" }, reason: "TOS" }, "req", FINANCE),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(sink.entries[0]).toMatchObject({ result: "error", statusCode: 403, actorEmail: "fin@kokoro.local" });
    // 被拒后不得发往上游（只有 manifest 一次 fetch）。
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/manifest"))).toBe(true);
  });

  it("denies an operator acting outside its tenant scope and records a 403 audit", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" }, siteId: "site_1", reason: "TOS" }, "req", TENANT),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(sink.entries[0]).toMatchObject({ result: "error", statusCode: 403, siteId: "site_1" });
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/manifest"))).toBe(true);
  });

  it("rejects a dangerMutation without a reason and records nothing", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" } }, "req", SUPER),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sink.entries).toHaveLength(0);
  });

  it("rejects an action absent from the manifest (anti open-proxy)", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "nope", reason: "x" }, "req", SUPER),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("records an error audit and surfaces 502 when the upstream rejects", async () => {
    const sink = new RecordingSink();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/manifest")) return jsonResponse({ data: userActionManifest });
      return jsonResponse({ error: { code: "x" } }, false, 409);
    });
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" }, reason: "TOS" }, "req", SUPER),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(sink.entries[0]).toMatchObject({ result: "error", statusCode: 409 });
  });
});

describe("executeAction 服务间转发头(内部密钥 + operator principal)", () => {
  const actionReq = {
    moduleId: "user",
    resourceId: "users",
    actionId: "disable",
    params: { id: "u_1" },
    siteId: "site_1",
    reason: "TOS",
  } as const;

  async function forwardHeaders(internalSecret: string): Promise<Record<string, string>> {
    const sink = new RecordingSink();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/manifest")) return jsonResponse({ data: userActionManifest });
      return jsonResponse({ data: { id: "u_1", status: "disabled" } });
    });
    const prepared = await prepareAction(modules, sink, actionReq, "req_1", SUPER);
    await executeAction(prepared, sink, actionReq, "req_1", internalSecret);
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/disable"));
    return (call?.[1] as RequestInit).headers as Record<string, string>;
  }

  it("配置 secret 时转发 x-kokoro-internal-secret，并带 operator principal 头", async () => {
    const headers = await forwardHeaders("sec-42");
    expect(headers["x-kokoro-internal-secret"]).toBe("sec-42");
    expect(JSON.parse(String(headers["x-kokoro-principal"]))).toEqual({
      kind: "operator",
      operatorId: "op_super",
      roleKey: "superadmin",
    });
  });

  it("secret 为空串时不带内部密钥头，但仍带 operator principal 头", async () => {
    const headers = await forwardHeaders("");
    expect(headers["x-kokoro-internal-secret"]).toBeUndefined();
    expect(headers["x-kokoro-principal"]).toBeDefined();
  });
});

const fullModules: ModuleConfig[] = [
  { id: "site", label: "Sites", baseUrl: "http://127.0.0.1:4201", manifestPath: "/admin/sites/manifest" },
  { id: "user", label: "Users", baseUrl: "http://127.0.0.1:4211", manifestPath: "/admin/users/manifest" },
  { id: "credit", label: "Credits", baseUrl: "http://127.0.0.1:4231", manifestPath: "/admin/credits/manifest" },
  { id: "payment", label: "Payments", baseUrl: "http://127.0.0.1:4241", manifestPath: "/admin/payments/manifest" },
];

function listManifest(id: string, basePath: string, resourceId: string, route: string): unknown {
  return {
    id,
    labelKey: "x",
    basePath,
    requiredPermission: "x.admin",
    navItems: [],
    resources: [{ id: resourceId, labelKey: "x", route, requiredPermission: "x.read", actions: [] }],
  };
}

function aggregationFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url.includes("/admin/sites/manifest")) return Promise.resolve(jsonResponse({ data: listManifest("kokoro-site", "/admin/sites", "sites", "/admin/sites") }));
  if (url.endsWith("/admin/sites")) return Promise.resolve(jsonResponse({ data: [{ id: "site1", key: "music" }] }));
  if (url.includes("/admin/credits/manifest")) return Promise.resolve(jsonResponse({ data: listManifest("kokoro-credit", "/admin/credits", "accounts", "/admin/credits/accounts") }));
  if (url.endsWith("/admin/credits/accounts")) return Promise.resolve(jsonResponse({ data: [{ id: "acc1", siteId: "s1", ownerKind: "team", ownerId: "t1", balanceMicros: "100" }, { id: "acc2", siteId: "s2", ownerKind: "team", ownerId: "t1" }] }));
  if (url.includes("/admin/payments/manifest")) return Promise.resolve(jsonResponse({ data: listManifest("kokoro-payment", "/admin/payments", "orders", "/admin/payments/orders") }));
  if (url.endsWith("/admin/payments/orders")) return Promise.resolve(jsonResponse({ data: [{ id: "o1", siteId: "s1", teamId: "t1" }, { id: "o2", siteId: "s1", teamId: "t2" }, { id: "o3", siteId: "s2", teamId: "t1" }] }));
  if (url.includes("/admin/users/manifest")) return Promise.resolve(jsonResponse({ data: listManifest("kokoro-user", "/admin/users", "users", "/admin/users") }));
  if (url.endsWith("/admin/users")) return Promise.resolve(jsonResponse({ data: [{ id: "u1", siteId: "s1", email: "a@b.c" }] }));
  return Promise.resolve(jsonResponse({}, false, 404));
}

describe("getSites", () => {
  it("returns all sites for a super-scoped operator", async () => {
    fetchMock.mockImplementation(aggregationFetch);
    expect(await getSites(fullModules, SUPER)).toEqual([{ id: "site1", key: "music" }]);
  });

  it("filters to the operator's tenant scope", async () => {
    fetchMock.mockImplementation(aggregationFetch);
    const scoped = { id: "o", email: "e", roleKey: "support", permissions: [], scopeSites: ["site1"] };
    const other = { id: "o2", email: "e2", roleKey: "support", permissions: [], scopeSites: ["site-x"] };
    expect(await getSites(fullModules, scoped)).toEqual([{ id: "site1", key: "music" }]);
    expect(await getSites(fullModules, other)).toEqual([]);
  });
});

describe("getUser360", () => {
  it("aggregates the matching account and site-scoped orders for a team owner", async () => {
    fetchMock.mockImplementation(aggregationFetch);
    const result = await getUser360(fullModules, { siteId: "s1", ownerKind: "team", ownerId: "t1" });
    expect(result.creditAccount?.id).toBe("acc1");
    expect(result.orders.map((order) => order.id)).toEqual(["o1"]);
    expect(result.identity).toBeNull();
  });

  it("resolves identity for a user owner", async () => {
    fetchMock.mockImplementation(aggregationFetch);
    const result = await getUser360(fullModules, { siteId: "s1", ownerKind: "user", ownerId: "u1" });
    expect(result.identity?.email).toBe("a@b.c");
  });

  it("degrades a single offline module to an empty segment without failing the whole view", async () => {
    fetchMock.mockImplementation((input) => {
      if (String(input).includes("/admin/credits/")) return Promise.reject(new Error("ECONNREFUSED"));
      return aggregationFetch(input);
    });
    const result = await getUser360(fullModules, { siteId: "s1", ownerKind: "team", ownerId: "t1" });
    expect(result.creditAccount).toBeNull();
    expect(result.orders.map((order) => order.id)).toEqual(["o1"]);
  });
});
