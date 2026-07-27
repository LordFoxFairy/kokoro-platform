import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { toConnectError } from "@kokoro/platform-kit";
import { describe, expect, it, vi } from "vitest";
import {
  AuthEventKind,
  ConsumeVerificationTokenRequestSchema,
  CreateVerificationTokenRequestSchema,
  OperatorStatus,
  RecordAuthEventRequestSchema,
} from "../../src/generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import { createAdminAuthService } from "../../src/admin-auth-service.js";
import type {
  AdminAuthReceiptRecord,
  AdminAuthStore,
  AdminAuthTransaction,
} from "../../src/admin-auth-store.js";

const now = new Date("2030-01-02T03:04:05.000Z");
const expires = new Date("2030-01-02T03:14:05.000Z");

class MemoryAdminAuthStore implements AdminAuthStore {
  operators = [
    { id: "active-1", email: "active@example.test", displayName: "Active", status: "active" as const },
    { id: "disabled-1", email: "disabled@example.test", displayName: "Disabled", status: "disabled" as const },
  ];
  receipts = new Map<string, AdminAuthReceiptRecord>();
  tokens = new Map<string, { identifier: string; token: string; expires: Date }>();
  events: Array<{ email: string; event: string; reason: string | null; occurredAt: Date }> = [];
  createTokenEffects = 0;
  consumeTokenEffects = 0;
  authEventEffects = 0;
  transactionFailure: unknown;

  async findOperatorByEmail(email: string) {
    return this.operators.find((operator) => operator.email === email) ?? null;
  }

  async findOperatorById(id: string) {
    return this.operators.find((operator) => operator.id === id) ?? null;
  }

  async findReceiptByCommandId(commandId: string) {
    return this.receipts.get(commandId) ?? null;
  }

  async transaction<T>(run: (transaction: AdminAuthTransaction) => Promise<T>): Promise<T> {
    if (this.transactionFailure !== undefined) throw this.transactionFailure;
    const receipts = new Map(this.receipts);
    const tokens = new Map(this.tokens);
    const events = [...this.events];
    let createTokenEffects = this.createTokenEffects;
    let consumeTokenEffects = this.consumeTokenEffects;
    let authEventEffects = this.authEventEffects;
    const transaction: AdminAuthTransaction = {
      findReceiptByCommandId: async (commandId) => receipts.get(commandId) ?? null,
      findReceiptByIdempotencyKey: async (idempotencyKey) =>
        [...receipts.values()].find((receipt) => receipt.idempotencyKey === idempotencyKey) ?? null,
      createReceipt: async (receipt) => {
        if (
          receipts.has(receipt.commandId) ||
          [...receipts.values()].some((existing) => existing.idempotencyKey === receipt.idempotencyKey)
        ) {
          throw new Error("duplicate receipt");
        }
        const created: AdminAuthReceiptRecord = { ...receipt, state: "accepted", result: null };
        receipts.set(created.commandId, created);
        return created;
      },
      commitReceipt: async (commandId, result, recordedAt) => {
        const existing = receipts.get(commandId);
        if (existing === undefined) throw new Error("missing receipt");
        const committed: AdminAuthReceiptRecord = { ...existing, state: "committed", result, recordedAt };
        receipts.set(commandId, committed);
        return committed;
      },
      createVerificationToken: async (value) => {
        createTokenEffects += 1;
        tokens.set(`${value.identifier}:${value.token}`, value);
        return value;
      },
      consumeVerificationToken: async ({ identifier, token }) => {
        consumeTokenEffects += 1;
        const key = `${identifier}:${token}`;
        const value = tokens.get(key) ?? null;
        tokens.delete(key);
        return value;
      },
      recordAuthEvent: async (value) => {
        authEventEffects += 1;
        events.push(value);
      },
    };
    const result = await run(transaction);
    this.receipts = receipts;
    this.tokens = tokens;
    this.events = events;
    this.createTokenEffects = createTokenEffects;
    this.consumeTokenEffects = consumeTokenEffects;
    this.authEventEffects = authEventEffects;
    return result;
  }
}

function command(commandId: string, digest: string) {
  return { commandId, idempotencyKey: `idempotency-${commandId}`, requestDigest: digest };
}

function digest(operation: string, payload: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify({ operation, payload }), "utf8").digest("hex");
}

function createTokenRequest(commandId = "create-1", digestOverride?: string, token = "raw-verification-token") {
  const identifier = "active@example.test";
  return create(CreateVerificationTokenRequestSchema, {
    command: command(
      commandId,
      digestOverride ??
        digest("admin_auth.create_verification_token", {
          identifier,
          token,
          expires: expires.toISOString(),
        }),
    ),
    identifier: " Active@Example.Test ",
    token,
    expires: timestampFromDate(expires),
  });
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

describe("Admin Auth application service", () => {
  it("normalizes email and maps active/disabled operator status", async () => {
    const store = new MemoryAdminAuthStore();
    const find = vi.spyOn(store, "findOperatorByEmail");
    const service = createAdminAuthService(store, { now: () => now });
    const active = await service.getOperatorByEmail({ email: " Active@Example.Test " } as never, {} as never);
    const disabled = await service.getOperatorByEmail({ email: "DISABLED@example.test" } as never, {} as never);
    expect(find).toHaveBeenNthCalledWith(1, "active@example.test");
    expect(active.operator?.status).toBe(OperatorStatus.ACTIVE);
    expect(disabled.operator?.status).toBe(OperatorStatus.DISABLED);
  });

  it("returns one committed receipt and applies create-token once for an exact replay", async () => {
    const store = new MemoryAdminAuthStore();
    const service = createAdminAuthService(store, { now: () => now });
    const first = await service.createVerificationToken(createTokenRequest(), {} as never);
    const replay = await service.createVerificationToken(createTokenRequest(), {} as never);
    expect(store.createTokenEffects).toBe(1);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.verificationToken?.token).toBe("raw-verification-token");
    expect(safeJson([...store.receipts.values()])).not.toContain("raw-verification-token");
    expect(safeJson(first.receipt)).not.toContain("raw-verification-token");
  });

  it("rejects a caller digest that does not match the normalized effect payload", async () => {
    const store = new MemoryAdminAuthStore();
    const service = createAdminAuthService(store, { now: () => now });
    await expect(
      Promise.resolve(
        service.createVerificationToken(createTokenRequest("invalid-digest", "a".repeat(64)), {} as never),
      ),
    ).rejects.toMatchObject({ kind: "validation", domainCode: "command.digest_invalid" });
    expect(store.createTokenEffects).toBe(0);
  });

  it("rejects a digest mismatch before applying another effect", async () => {
    const store = new MemoryAdminAuthStore();
    const service = createAdminAuthService(store, { now: () => now });
    await service.createVerificationToken(createTokenRequest(), {} as never);
    const mismatched = service.createVerificationToken(
      createTokenRequest("create-1", undefined, "different-token"),
      {} as never,
    );
    await expect(mismatched).rejects.toMatchObject({ kind: "conflict", domainCode: "command.digest_conflict" });
    expect(store.createTokenEffects).toBe(1);
  });

  it("atomically consumes a token once and replays the same safe result", async () => {
    const store = new MemoryAdminAuthStore();
    store.tokens.set("active@example.test:raw-verification-token", {
      identifier: "active@example.test",
      token: "raw-verification-token",
      expires,
    });
    const service = createAdminAuthService(store, { now: () => now });
    const request = create(ConsumeVerificationTokenRequestSchema, {
      command: command(
        "consume-1",
        digest("admin_auth.consume_verification_token", {
          identifier: "active@example.test",
          token: "raw-verification-token",
        }),
      ),
      identifier: "Active@Example.Test",
      token: "raw-verification-token",
    });
    const first = await service.consumeVerificationToken(request, {} as never);
    const replay = await service.consumeVerificationToken(request, {} as never);
    expect(store.consumeTokenEffects).toBe(1);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.verificationToken?.expires).toEqual(timestampFromDate(expires));
  });

  it("records an auth event once and reconciles the authoritative receipt without a token", async () => {
    const store = new MemoryAdminAuthStore();
    const service = createAdminAuthService(store, { now: () => now });
    const request = create(RecordAuthEventRequestSchema, {
      command: command(
        "event-1",
        digest("admin_auth.record_auth_event", {
          email: "active@example.test",
          event: "signin",
          reason: "",
          occurredAt: now.toISOString(),
        }),
      ),
      email: "Active@Example.Test",
      event: AuthEventKind.SIGN_IN,
      occurredAt: timestampFromDate(now),
    });
    await service.recordAuthEvent(request, {} as never);
    await service.recordAuthEvent(request, {} as never);
    const receipt = await service.getCommandReceipt(
      { commandId: "event-1", requestDigest: request.command?.requestDigest ?? "" } as never,
      {} as never,
    );
    expect(store.authEventEffects).toBe(1);
    expect(store.events).toEqual([
      { email: "active@example.test", event: "signin", reason: null, occurredAt: now },
    ]);
    expect(receipt.result?.case).toBe("authEvent");
    expect(safeJson(receipt)).not.toContain("raw-verification-token");
  });

  it("sanitizes database failures before they cross the Connect boundary", async () => {
    const store = new MemoryAdminAuthStore();
    store.transactionFailure = new Error("Prisma admin@example.test raw-verification-token");
    const service = createAdminAuthService(store, { now: () => now });
    const failure = await Promise.resolve(service.createVerificationToken(createTokenRequest(), {} as never)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ retryClass: "reconcile_receipt", receiptRef: "create-1" });
    const connectError = toConnectError(failure);
    expect(connectError.code).toBe(Code.Unavailable);
    expect(connectError.rawMessage).toBe("Admin Auth persistence unavailable");
    expect(connectError.rawMessage).not.toContain("admin@example.test");
    expect(connectError.rawMessage).not.toContain("raw-verification-token");
  });
});
