import { describe, expect, it } from "vitest";
import { AdminAuthService } from "../../src/generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";

describe("generated Admin Auth contract", () => {
  it("exposes all v1 unary method descriptors from the Platform mirror", () => {
    expect(AdminAuthService.methods.map((method) => method.localName)).toEqual([
      "getOperatorByEmail",
      "getOperator",
      "createVerificationToken",
      "consumeVerificationToken",
      "recordAuthEvent",
      "getCommandReceipt",
    ]);
    expect(AdminAuthService.methods.every((method) => method.methodKind === "unary")).toBe(true);
  });
});
