import { describe, expect, it } from "vitest";
import { validateMcpServerUrl } from "../../src/interfaces/http/mcp-url-guard.js";

// 注入解析器：把 host 映射到给定 IP，避免测试打真实 DNS。
function resolverFor(map: Record<string, string[]>) {
  return async (host: string): Promise<string[]> => {
    const addrs = map[host];
    if (addrs === undefined) {
      throw new Error(`no DNS record for ${host}`);
    }
    return addrs;
  };
}

const SECURE = { allowInsecure: false as const };

describe("validateMcpServerUrl — shape guards", () => {
  it("accepts an https url resolving to a public address", async () => {
    const result = await validateMcpServerUrl("https://mcp.example/github", {
      ...SECURE,
      resolver: resolverFor({ "mcp.example": ["93.184.216.34"] }),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects http when insecure is not allowed", async () => {
    const result = await validateMcpServerUrl("http://mcp.example/github", {
      ...SECURE,
      resolver: resolverFor({ "mcp.example": ["93.184.216.34"] }),
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects userinfo and malformed urls", async () => {
    expect((await validateMcpServerUrl("https://user:pass@mcp.example/x", SECURE)).ok).toBe(false);
    expect((await validateMcpServerUrl("not-a-url", SECURE)).ok).toBe(false);
  });

  it("rejects a host that cannot be resolved", async () => {
    const result = await validateMcpServerUrl("https://ghost.example/x", {
      ...SECURE,
      resolver: resolverFor({}),
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateMcpServerUrl — forbidden IPv4 ranges (literal + via DNS)", () => {
  const forbidden: Array<[string, string]> = [
    ["loopback", "127.0.0.1"],
    ["private-10", "10.1.2.3"],
    ["private-172", "172.16.5.5"],
    ["private-192", "192.168.1.1"],
    ["link-local", "169.254.10.10"],
    ["metadata", "169.254.169.254"],
    ["cgnat", "100.64.0.1"],
    ["multicast", "224.0.0.1"],
    ["unspecified", "0.0.0.0"],
    ["reserved-240", "240.0.0.1"],
    ["protocol-assignments", "192.0.0.1"],
    ["documentation-1", "192.0.2.1"],
    ["benchmarking", "198.18.0.1"],
    ["documentation-2", "198.51.100.1"],
    ["documentation-3", "203.0.113.1"],
  ];

  for (const [label, ip] of forbidden) {
    it(`rejects ${label} as an ip literal`, async () => {
      const result = await validateMcpServerUrl(`https://${ip}/x`, SECURE);
      expect(result, `${ip} literal`).toMatchObject({ ok: false });
    });
    it(`rejects ${label} when a hostname resolves to it`, async () => {
      const result = await validateMcpServerUrl("https://evil.example/x", {
        ...SECURE,
        resolver: resolverFor({ "evil.example": [ip] }),
      });
      expect(result, `${ip} via dns`).toMatchObject({ ok: false });
    });
  }

  it("rejects when any of several resolved addresses is private (mixed A records)", async () => {
    const result = await validateMcpServerUrl("https://mixed.example/x", {
      ...SECURE,
      resolver: resolverFor({ "mixed.example": ["93.184.216.34", "169.254.169.254"] }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateMcpServerUrl — forbidden IPv6 ranges", () => {
  const forbidden: Array<[string, string]> = [
    ["loopback", "::1"],
    ["unspecified", "::"],
    ["link-local", "fe80::1"],
    ["ula", "fc00::1"],
    ["multicast", "ff02::1"],
    ["ipv4-mapped-metadata", "::ffff:169.254.169.254"],
    ["discard-only", "100::1"],
    ["deprecated-site-local", "fec0::1"],
    ["documentation", "2001:db8::1"],
  ];

  for (const [label, ip] of forbidden) {
    it(`rejects ${label} (${ip}) as a bracketed literal`, async () => {
      const result = await validateMcpServerUrl(`https://[${ip}]/x`, SECURE);
      expect(result, `${ip}`).toMatchObject({ ok: false });
    });
    it(`rejects ${label} (${ip}) when a hostname resolves to it`, async () => {
      const result = await validateMcpServerUrl("https://evil-v6.example/x", {
        ...SECURE,
        resolver: resolverFor({ "evil-v6.example": [ip] }),
      });
      expect(result, `${ip} via dns`).toMatchObject({ ok: false });
    });
  }

  it("accepts a public IPv6 literal", async () => {
    const result = await validateMcpServerUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/x", SECURE);
    expect(result.ok).toBe(true);
  });
});

describe("validateMcpServerUrl — admin insecure profile", () => {
  it("allows http only when it still resolves exclusively to public unicast", async () => {
    const result = await validateMcpServerUrl("http://mcp.example/x", {
      allowInsecure: true,
      resolver: resolverFor({ "mcp.example": ["93.184.216.34"] }),
    });
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    ["private literal", "http://127.0.0.1/x", {}],
    [
      "metadata via DNS",
      "http://metadata.example/x",
      { resolver: resolverFor({ "metadata.example": ["169.254.169.254"] }) },
    ],
  ])("never bypasses the address guard for %s", async (_label, url, options) => {
    const result = await validateMcpServerUrl(url, { allowInsecure: true, ...options });
    expect(result).toMatchObject({ ok: false });
  });

  it("still rejects a non-http(s) scheme even when insecure is allowed", async () => {
    expect((await validateMcpServerUrl("ftp://localhost/x", { allowInsecure: true })).ok).toBe(false);
  });
});
