import { describe, expect, it, vi } from "vitest";
import { makePrismaAdminAuthStore } from "../../src/admin-auth-store.js";

describe("Prisma Admin Auth store", () => {
  it("keeps owner mutations on the Prisma transaction and atomically consumes tokens", async () => {
    const findUnique = vi.fn(async () => ({
      id: "op-1",
      email: "admin@kokoro.local",
      displayName: "Admin",
      status: "active",
    }));
    const createToken = vi.fn(async ({ data }) => data);
    const removeToken = vi.fn(async ({ where }) => ({
      identifier: where.identifier_token.identifier,
      token: where.identifier_token.token,
      expires: new Date("2033-05-18T03:33:20.000Z"),
    }));
    const createEvent = vi.fn(async () => undefined);
    const transactionClient = {
      adminAuthCommandReceipt: {},
      verificationToken: { create: createToken, delete: removeToken },
      authEvent: { create: createEvent },
    };
    const transaction = vi.fn(async (run) => run(transactionClient));
    const store = makePrismaAdminAuthStore({
      operatorAccount: { findUnique },
      adminAuthCommandReceipt: { findUnique: vi.fn() },
      $transaction: transaction,
    } as never);

    await expect(store.findOperatorByEmail("admin@kokoro.local")).resolves.toMatchObject({ id: "op-1" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: "admin@kokoro.local" },
      select: { id: true, email: true, displayName: true, status: true },
    });

    const token = {
      identifier: "admin@kokoro.local",
      token: "token-1",
      expires: new Date("2033-05-18T03:33:20.000Z"),
    };
    await store.transaction(async (tx) => {
      await expect(tx.createVerificationToken(token)).resolves.toEqual(token);
      await expect(tx.consumeVerificationToken(token)).resolves.toEqual(token);
      await tx.recordAuthEvent({
        email: token.identifier,
        event: "signin",
        reason: null,
        occurredAt: new Date("2033-05-18T03:30:00.000Z"),
      });
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(createEvent).toHaveBeenCalledOnce();

    removeToken.mockRejectedValueOnce({ code: "P2025" });
    await store.transaction(async (tx) => {
      await expect(tx.consumeVerificationToken(token)).resolves.toBeNull();
    });
    removeToken.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(store.transaction(async (tx) => tx.consumeVerificationToken(token))).rejects.toThrow(
      "database unavailable",
    );
  });
});
