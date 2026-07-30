import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { HmacAdminPageCursorCodec } from
  "../../src/modules/admin/infrastructure/security/admin-page-cursor.js";
import {
  createAdminQueryConnectService,
  type AdminQueryPermit,
} from "../../src/modules/admin/interfaces/connect/admin-query-service.js";

const transport = {} as HandlerContext;

describe("Admin query pagination", () => {
  it("authenticates canonical cursor payloads and rejects tampering", () => {
    const codec = new HmacAdminPageCursorCodec(Buffer.alloc(32, 3));
    const token = codec.encode({ kind: "sites", after: "site:1", binding: "a".repeat(64) });

    expect(codec.decode(token)).toEqual({ kind: "sites", after: "site:1", binding: "a".repeat(64) });
    expect(() => codec.encode(Object.fromEntries("abcdefgh".split("").map((key) =>
      [key, "x".repeat(256)])))).toThrow("ADMIN_PAGE_TOKEN_INVALID");
    const suffix = token.endsWith("A") ? "B" : "A";
    expect(() => codec.decode(`${token.slice(0, -1)}${suffix}`))
      .toThrow("ADMIN_PAGE_TOKEN_INVALID");
  });

  it("binds a cursor to the exact operator, environment, region, operation and authority scope", async () => {
    const codec = new HmacAdminPageCursorCodec(Buffer.alloc(32, 5));
    const reader = {
      getSite: vi.fn(),
      getUser: vi.fn(),
      getOperator: vi.fn(),
      listOperators: vi.fn(),
      listPendingApprovals: vi.fn(),
      listAudit: vi.fn(),
      listSites: vi.fn(async () => [
        { siteRef: "site:1", status: "active", securityEpoch: 1n },
        { siteRef: "site:2", status: "active", securityEpoch: 1n },
      ]),
    };
    const first = createAdminQueryConnectService({
      resolver: { resolve: async () => permit(["site:1"]) }, reader, cursors: codec,
    });
    const page = await first.listSites({ context: {}, pageSize: 1 } as never, transport);
    const pageToken = page.nextPageToken;
    expect(pageToken).toBeDefined();

    const second = createAdminQueryConnectService({
      resolver: { resolve: async () => permit(["site:2"]) }, reader, cursors: codec,
    });
    await expect(second.listSites({ context: {}, pageSize: 1, pageToken } as never, transport))
      .rejects.toThrow("ADMIN_PAGE_TOKEN_INVALID");
    expect(reader.listSites).toHaveBeenCalledTimes(1);
  });
});

function permit(siteRefs: readonly string[]): AdminQueryPermit {
  return Object.freeze({
    operatorRef: "operator:1",
    environment: "production",
    region: "us-east-1",
    operation: "admin.site.list",
    scope: Object.freeze({ kind: "site", siteRefs: Object.freeze([...siteRefs]) }),
  });
}
