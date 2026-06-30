import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleConfig } from "../../src/config.js";
import {
  GatewayError,
  getManifests,
  getSites,
  getUser360,
  proxyAction,
  proxyResource,
  type AuditEntry,
  type AuditSink,
} from "../../src/gateway.js";

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
    );

    expect(result).toEqual({ id: "u_1", status: "disabled" });
    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/disable"));
    expect(String(call?.[0])).toContain("/admin/users/u_1/disable");
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-kokoro-site-id"]).toBe("site_1");
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]).toMatchObject({ result: "ok", statusCode: 200, targetRoute: "/admin/users/u_1/disable" });
  });

  it("rejects a dangerMutation without a reason and records nothing", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" } }, "req"),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(sink.entries).toHaveLength(0);
  });

  it("rejects an action absent from the manifest (anti open-proxy)", async () => {
    const sink = new RecordingSink();
    fetchMock.mockResolvedValue(jsonResponse({ data: userActionManifest }));
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "nope", reason: "x" }, "req"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("records an error audit and surfaces 502 when the upstream rejects", async () => {
    const sink = new RecordingSink();
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes("/manifest")) return jsonResponse({ data: userActionManifest });
      return jsonResponse({ error: { code: "x" } }, false, 409);
    });
    await expect(
      proxyAction(modules, sink, { moduleId: "user", resourceId: "users", actionId: "disable", params: { id: "u_1" }, reason: "TOS" }, "req"),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(sink.entries[0]).toMatchObject({ result: "error", statusCode: 409 });
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
  it("proxies the site admin list", async () => {
    fetchMock.mockImplementation(aggregationFetch);
    expect(await getSites(fullModules)).toEqual([{ id: "site1", key: "music" }]);
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
