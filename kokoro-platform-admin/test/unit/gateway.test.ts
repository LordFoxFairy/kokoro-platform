import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleConfig } from "../../src/config.js";
import { GatewayError, getManifests, proxyResource } from "../../src/gateway.js";

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
