import { describe, expect, it } from "vitest";
import { createIdentityPublicOperations } from "../../src/modules/identity/interfaces/http/identity-public-operations.js";

describe("Identity public operation adapters", () => {
  it("keeps disableTotp reachable when the generated contract declares no receipt recovery", async () => {
    let received: unknown;
    const operations = createIdentityPublicOperations({} as never, {
      async disableTotp(input: unknown) {
        received = input;
        return { receipt: { state: "committed" } };
      },
    } as never);
    const operation = operations.find((candidate) => candidate.operationId === "disableTotp");
    if (operation === undefined) throw new Error("disableTotp operation missing");

    const result = await operation.execute({
      workload: { siteRef: "site-1" },
      context: {},
      session: { identitySessionRef: "session-1" },
      headers: {
        "X-Kokoro-Command-Id": "1".repeat(32),
        "Idempotency-Key": "disable-1",
      },
      body: { code: "123456", reauthenticationProof: "proof" },
      receiptRecoveryCapability: null,
    } as never);

    expect(result).toEqual({ receipt: { state: "committed" } });
    expect(received).toMatchObject({
      commandId: "1".repeat(32),
      code: "123456",
      reauthenticationProof: "proof",
    });
    expect(received).not.toHaveProperty("receiptRecoveryCapability");
  });
});
