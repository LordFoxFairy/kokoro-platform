import { describe, expect, it } from "vitest";
import { permits, requirePermission, OperatorAuthError, type Operator } from "../../src/rbac.js";

describe("permits", () => {
  it.each([
    [["*"], "credit.grant", true],
    [["*"], "anything.at.all", true],
    [["credit.*"], "credit.grant", true],
    [["credit.*"], "credit.account.read", true],
    [["credit.*"], "payment.refund", false],
    [["credit.grant"], "credit.grant", true],
    [["credit.grant"], "credit.account.read", false],
    [[], "credit.grant", false],
    [["payment.*", "credit.grant"], "payment.order.refund", true],
    [["payment.*", "credit.grant"], "user.disable", false],
  ])("permissions %j vs %s -> %s", (perms, required, expected) => {
    expect(permits(perms as string[], required as string)).toBe(expected);
  });
});

describe("requirePermission", () => {
  const finance: Operator = { id: "o", email: "f@x.c", roleKey: "finance", permissions: ["payment.*", "credit.grant"] };

  it("passes when permitted", () => {
    expect(() => requirePermission(finance, "payment.order.refund")).not.toThrow();
  });

  it("throws OperatorAuthError(403) when not permitted", () => {
    expect(() => requirePermission(finance, "user.disable")).toThrow(OperatorAuthError);
    try {
      requirePermission(finance, "user.disable");
    } catch (error) {
      expect((error as OperatorAuthError).statusCode).toBe(403);
    }
  });
});
