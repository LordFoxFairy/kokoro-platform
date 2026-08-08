import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { ListPendingApprovalsResponseSchema, PendingApprovalOwner } from
  "../../src/generated/proto/kokoro/platform/admin/v2/admin_query_pb.js";
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

  it("keeps a maximum approval cursor inside the generated RPC envelope", () => {
    const codec = new HmacAdminPageCursorCodec(Buffer.alloc(32, 4));
    const token = codec.encode({
      kind: "approvals",
      at: "2026-08-07T23:59:59.999999Z",
      owner: "site_lifecycle",
      ref: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      binding: "b".repeat(64),
    });

    expect(token.length).toBeGreaterThan(256);
    expect(token.length).toBeLessThanOrEqual(1024);
    expect(createValidator().validate(
      ListPendingApprovalsResponseSchema,
      create(ListPendingApprovalsResponseSchema, { nextPageToken: token }),
    ).kind).toBe("valid");
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

  it("carries the exact PostgreSQL instant and owner through an opaque approval cursor", async () => {
    const codec = new HmacAdminPageCursorCodec(Buffer.alloc(32, 6));
    const resolve = vi.fn(async () => approvalPermit());
    const listPendingApprovals = vi.fn(async () => [
      pendingApproval("generic_admin", "10000000-0000-4000-8000-000000000001",
        "2026-08-08T12:00:00.123456Z"),
      pendingApproval("site_lifecycle", "10000000-0000-4000-8000-000000000001",
        "2026-08-08T12:00:00.123123Z"),
    ]);
    const service = createAdminQueryConnectService({
      resolver: { resolve },
      reader: {
        getSite: vi.fn(), getUser: vi.fn(), getOperator: vi.fn(), listOperators: vi.fn(),
        listPendingApprovals, listAudit: vi.fn(), listSites: vi.fn(),
      },
      cursors: codec,
    });

    const first = await service.listPendingApprovals(
      { context: {}, pageSize: 1 } as never,
      transport,
    );
    expect(first.approvals?.[0]?.owner).toBe(PendingApprovalOwner.GENERIC_ADMIN);
    expect(first.approvals?.[0]?.admittedAt).toMatchObject({ nanos: 123_456_000 });
    expect(first.nextPageToken).toBeDefined();
    expect(codec.decode(first.nextPageToken!)).toEqual({
      kind: "approvals",
      at: "2026-08-08T12:00:00.123456Z",
      owner: "generic_admin",
      ref: "10000000-0000-4000-8000-000000000001",
      binding: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(resolve).toHaveBeenCalledWith(expect.anything(), transport, {
      operation: "admin.approval.list",
      siteRef: null,
      resourceRefs: [],
      fieldRefs: [
        "approval_ref", "owner", "operation", "maker_ref", "target_site_ref",
        "environment", "region", "operator_reason", "admitted_at", "expires_at",
      ],
    });

    await service.listPendingApprovals(
      { context: {}, pageSize: 1, pageToken: first.nextPageToken } as never,
      transport,
    );
    expect(listPendingApprovals).toHaveBeenLastCalledWith(expect.anything(), {
      siteRef: null,
      before: {
        admittedAt: "2026-08-08T12:00:00.123456Z",
        owner: "generic_admin",
        approvalRef: "10000000-0000-4000-8000-000000000001",
      },
      limit: 2,
    });
  });

  it("normalizes a signed approval cursor with an invalid instant", async () => {
    const codec = new HmacAdminPageCursorCodec(Buffer.alloc(32, 7));
    const listPendingApprovals = vi.fn(async () => [
      pendingApproval("generic_admin", "10000000-0000-4000-8000-000000000001",
        "2026-08-08T12:00:00.123456Z"),
      pendingApproval("site_lifecycle", "10000000-0000-4000-8000-000000000001",
        "2026-08-08T12:00:00.123123Z"),
    ]);
    const service = createAdminQueryConnectService({
      resolver: { resolve: async () => approvalPermit() },
      reader: {
        getSite: vi.fn(), getUser: vi.fn(), getOperator: vi.fn(), listOperators: vi.fn(),
        listPendingApprovals, listAudit: vi.fn(), listSites: vi.fn(),
      },
      cursors: codec,
    });
    const first = await service.listPendingApprovals(
      { context: {}, pageSize: 1 } as never,
      transport,
    );
    const decoded = codec.decode(first.nextPageToken!);
    const malformed = codec.encode({ ...decoded, at: "2026-08-08T12:00:00.123Z" });

    await expect(service.listPendingApprovals(
      { context: {}, pageSize: 1, pageToken: malformed } as never,
      transport,
    )).rejects.toThrow("ADMIN_PAGE_TOKEN_INVALID");
    expect(listPendingApprovals).toHaveBeenCalledTimes(1);
  });
});

function permit(siteRefs: readonly string[]): AdminQueryPermit {
  return Object.freeze({
    operatorRef: "operator:1",
    environment: "production",
    region: "us-east-1",
    operation: "admin.site.list",
    authorityBindingDigest: "a".repeat(64),
    scope: Object.freeze({ kind: "site", siteRefs: Object.freeze([...siteRefs]) }),
  });
}

function approvalPermit(): AdminQueryPermit {
  return Object.freeze({
    operatorRef: "operator:1",
    environment: "production",
    region: "us-east-1",
    operation: "admin.approval.list",
    authorityBindingDigest: "c".repeat(64),
    scope: Object.freeze({ kind: "global", grantRef: "grant:1" }),
  });
}

function pendingApproval(owner: "generic_admin" | "site_lifecycle", approvalRef: string, admittedAt: string) {
  return Object.freeze({
    owner,
    approvalRef,
    operation: owner === "generic_admin" ? "admin.authority.change" : "site.activation.begin",
    makerRef: "operator:maker",
    targetSiteRef: "site:alpha",
    environment: "production",
    region: "us-east-1",
    operatorReason: "review change",
    admittedAt,
    expiresAt: "2026-08-08T12:10:00.000001Z",
  });
}
