import { describe, expect, it } from "vitest";
import { createAdminAuthorityCommandHandler } from
  "../../src/modules/admin-control/infrastructure/postgres/admin-authority-command-handler.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Admin authority command handler", () => {
  it("delegates a frozen approved payload to the guarded database function", async () => {
    const statements: unknown[] = [];
    const lease = issuePlatformTransaction({
      async query(statement, values) {
        statements.push({ statement, values });
        return [{ result: { state: "suspended", authorizationEpoch: "9" } }] as never;
      },
      async execute() { return 0; },
    });
    try {
      const handler = createAdminAuthorityCommandHandler();
      const result = await handler.execute(lease.transaction, {
        admission: {} as never,
        approval: { approvalRef: "018f1414-1414-7414-8414-141414141414" } as never,
        payload: { action: "suspend", operatorRef: "operator_01",
          operatorGeneration: "2", expectedAuthorizationEpoch: "8" },
        requestDigest: "a".repeat(64),
      });
      expect(handler.definition).toMatchObject({ commandId: "admin.authority.change",
        permission: "admin.authority.manage", effectClass: "dangerous",
        approvalPolicy: "pre_effect" });
      expect(statements[0]).toMatchObject({
        statement: expect.stringContaining("platform.apply_admin_authority_change"),
        values: ["018f1414-1414-7414-8414-141414141414", expect.any(String)],
      });
      expect(result).toEqual({ disposition: "succeeded",
        result: { state: "suspended", authorizationEpoch: "9" } });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed when invoked outside an approved worker execution", async () => {
    const handler = createAdminAuthorityCommandHandler();
    const lease = issuePlatformTransaction({ async query() { return []; }, async execute() { return 0; } });
    try {
      await expect(handler.execute(lease.transaction, {
        admission: {} as never, payload: {}, requestDigest: "a".repeat(64),
      })).rejects.toThrow("ADMIN_AUTHORITY_APPROVAL_REQUIRED");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("returns a terminal business rejection instead of retrying a permanent authority conflict", async () => {
    const handler = createAdminAuthorityCommandHandler();
    const lease = issuePlatformTransaction({
      async query() { throw new Error("ADMIN_AUTHORITY_QUORUM_REQUIRED"); },
      async execute() { return 0; },
    });
    try {
      await expect(handler.execute(lease.transaction, {
        admission: {} as never,
        approval: { approvalRef: "018f1414-1414-7414-8414-141414141414" } as never,
        payload: { action: "revoke" }, requestDigest: "a".repeat(64),
      })).resolves.toEqual({ disposition: "rejected",
        code: "ADMIN_AUTHORITY_QUORUM_REQUIRED",
        result: { code: "ADMIN_AUTHORITY_QUORUM_REQUIRED" } });
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});
