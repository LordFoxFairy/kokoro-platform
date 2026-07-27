import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import {
  contextHeaders,
  readRequestContext,
  requireSite,
  SiteContextRequiredError,
  type RequestContext,
} from "../../src/http/request-context.js";

describe("readRequestContext", () => {
  it("parses each principal kind from the principal header", () => {
    const kinds = [
      { kind: "user", userId: "u_1" },
      { kind: "service", serviceAccountId: "sa_1" },
      { kind: "operator", operatorId: "op_1", roleKey: "ops" },
      { kind: "system" },
      { kind: "anonymous" },
    ];
    for (const principal of kinds) {
      const ctx = readRequestContext({ "x-kokoro-principal": JSON.stringify(principal) });
      expect(ctx.principal).toEqual(principal);
    }
  });

  it("preserves an inbound request id and generates one when absent", () => {
    expect(readRequestContext({ "x-kokoro-request-id": "req_42" }).requestId).toBe("req_42");
    expect(readRequestContext({}).requestId).toMatch(/.+/);
  });

  it("defaults siteId to null and principal to anonymous when headers are absent", () => {
    const ctx = readRequestContext({});
    expect(ctx.siteId).toBeNull();
    expect(ctx.principal).toEqual({ kind: "anonymous" });
    expect(ctx.teamId).toBeUndefined();
  });

  it("fails closed to anonymous for a malformed or unsupported principal header", () => {
    expect(readRequestContext({ "x-kokoro-principal": "{not-json" }).principal).toEqual({ kind: "anonymous" });
    expect(readRequestContext({ "x-kokoro-principal": '{"kind":"alien"}' }).principal).toEqual({ kind: "anonymous" });
  });

  it("reads a single value when a header arrives as an array", () => {
    const headers: IncomingHttpHeaders = { "x-kokoro-site-id": ["site_a", "site_b"] };
    expect(readRequestContext(headers).siteId).toBe("site_a");
  });
});

describe("requireSite", () => {
  it("returns the siteId when present", () => {
    const ctx: RequestContext = { requestId: "r", siteId: "site_1", principal: { kind: "system" } };
    expect(requireSite(ctx)).toBe("site_1");
  });

  it("throws SiteContextRequiredError when siteId is null", () => {
    const ctx: RequestContext = { requestId: "r", siteId: null, principal: { kind: "system" } };
    expect(() => requireSite(ctx)).toThrow(SiteContextRequiredError);
  });
});

describe("contextHeaders round-trip", () => {
  it("re-reads to an equivalent context for cross-service forwarding", () => {
    const ctx: RequestContext = {
      requestId: "req_7",
      siteId: "site_9",
      principal: { kind: "operator", operatorId: "op_1", roleKey: "finance" },
      teamId: "team_3",
    };
    expect(readRequestContext(contextHeaders(ctx))).toEqual(ctx);
  });

  it("omits siteId and teamId headers when they are absent", () => {
    const headers = contextHeaders({ requestId: "r", siteId: null, principal: { kind: "system" } });
    expect(headers).not.toHaveProperty("x-kokoro-site-id");
    expect(headers).not.toHaveProperty("x-kokoro-team-id");
  });
});
