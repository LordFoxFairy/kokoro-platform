import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminAuthService } from "../../src/admin-auth-service.js";
import { makePrismaAdminAuthStore } from "../../src/admin-auth-store.js";
import {
  AuthEventKind,
  ConsumeVerificationTokenRequestSchema,
  CreateVerificationTokenRequestSchema,
  RecordAuthEventRequestSchema,
} from "../../src/generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import { createAdminPrisma } from "../../src/prisma.js";

const databaseUrl = process.env.DATABASE_URL_ADMIN;
const isolatedDatabase =
  databaseUrl !== undefined &&
  (databaseUrl.includes("@127.0.0.1:") || databaseUrl.includes("@localhost:")) &&
  new URL(databaseUrl).pathname === "/kokoro_admin_verify";

describe.skipIf(!isolatedDatabase)("Admin Auth Prisma receipts", () => {
  const prisma = createAdminPrisma(databaseUrl ?? "mysql://invalid/disabled");
  const store = makePrismaAdminAuthStore(prisma);
  const now = new Date("2030-01-02T03:04:05.000Z");
  const expires = new Date("2030-01-02T03:14:05.000Z");
  const service = createAdminAuthService(store, { now: () => now });

  function digest(operation: string, payload: Record<string, string>): string {
    return createHash("sha256").update(JSON.stringify({ operation, payload }), "utf8").digest("hex");
  }

  function command(commandId: string, requestDigest: string) {
    return { commandId, idempotencyKey: `idempotency-${commandId}`, requestDigest };
  }

  beforeAll(async () => {
    await prisma.adminAuthCommandReceipt.deleteMany();
    await prisma.authEvent.deleteMany();
    await prisma.verificationToken.deleteMany();
    await prisma.operatorAccount.deleteMany();
    await prisma.operatorRole.deleteMany();
    await prisma.operatorRole.create({ data: { key: "test", name: "Test", permissions: [] } });
    await prisma.operatorAccount.create({
      data: {
        id: "operator-1",
        email: "operator@example.test",
        displayName: "Operator",
        roleKey: "test",
        scopeSites: [],
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("commits create effect and receipt once, then reconciles without persisting the token", async () => {
    const requestDigest = digest("admin_auth.create_verification_token", {
      identifier: "operator@example.test",
      token: "raw-verification-token",
      expires: expires.toISOString(),
    });
    const request = create(CreateVerificationTokenRequestSchema, {
      command: command("create-db-1", requestDigest),
      identifier: "Operator@Example.Test",
      token: "raw-verification-token",
      expires: timestampFromDate(expires),
    });
    const first = await service.createVerificationToken(request, {} as never);
    const replay = await service.createVerificationToken(request, {} as never);
    const reconciled = await service.getCommandReceipt(
      { commandId: "create-db-1", requestDigest } as never,
      {} as never,
    );
    expect(replay.receipt).toEqual(first.receipt);
    expect(await prisma.verificationToken.count()).toBe(1);
    expect(await prisma.adminAuthCommandReceipt.count()).toBe(1);
    expect(JSON.stringify(await prisma.adminAuthCommandReceipt.findMany())).not.toContain("raw-verification-token");
    expect(reconciled.result?.case).toBe("verificationToken");
  });

  it("rejects digest mismatch before another effect", async () => {
    const mismatched = create(CreateVerificationTokenRequestSchema, {
      command: command(
        "create-db-1",
        digest("admin_auth.create_verification_token", {
          identifier: "operator@example.test",
          token: "different-token",
          expires: expires.toISOString(),
        }),
      ),
      identifier: "operator@example.test",
      token: "different-token",
      expires: timestampFromDate(expires),
    });
    await expect(Promise.resolve(service.createVerificationToken(mismatched, {} as never))).rejects.toMatchObject({
      domainCode: "command.digest_conflict",
    });
    expect(await prisma.verificationToken.count()).toBe(1);
  });

  it("rolls back a failed consume receipt and atomically replays a successful consume", async () => {
    const missing = create(ConsumeVerificationTokenRequestSchema, {
      command: command(
        "consume-missing",
        digest("admin_auth.consume_verification_token", {
          identifier: "operator@example.test",
          token: "missing-token",
        }),
      ),
      identifier: "operator@example.test",
      token: "missing-token",
    });
    await expect(Promise.resolve(service.consumeVerificationToken(missing, {} as never))).rejects.toMatchObject({
      domainCode: "verification_token.not_found",
    });
    expect(await prisma.adminAuthCommandReceipt.findUnique({ where: { commandId: "consume-missing" } })).toBeNull();

    const request = create(ConsumeVerificationTokenRequestSchema, {
      command: command(
        "consume-db-1",
        digest("admin_auth.consume_verification_token", {
          identifier: "operator@example.test",
          token: "raw-verification-token",
        }),
      ),
      identifier: "operator@example.test",
      token: "raw-verification-token",
    });
    const first = await service.consumeVerificationToken(request, {} as never);
    const replay = await service.consumeVerificationToken(request, {} as never);
    expect(replay.receipt).toEqual(first.receipt);
    expect(await prisma.verificationToken.count()).toBe(0);
    expect(await prisma.adminAuthCommandReceipt.count({ where: { commandId: "consume-db-1" } })).toBe(1);
  });

  it("deduplicates an auth event through the same command receipt", async () => {
    const request = create(RecordAuthEventRequestSchema, {
      command: command(
        "event-db-1",
        digest("admin_auth.record_auth_event", {
          email: "operator@example.test",
          event: "signin",
          reason: "",
          occurredAt: now.toISOString(),
        }),
      ),
      email: "Operator@Example.Test",
      event: AuthEventKind.SIGN_IN,
      occurredAt: timestampFromDate(now),
    });
    await service.recordAuthEvent(request, {} as never);
    await service.recordAuthEvent(request, {} as never);
    expect(await prisma.authEvent.count()).toBe(1);
    expect(await prisma.adminAuthCommandReceipt.count({ where: { commandId: "event-db-1" } })).toBe(1);
  });

  it("serializes simultaneous same-command writers through one effect and receipt", async () => {
    const request = create(CreateVerificationTokenRequestSchema, {
      command: command(
        "create-race-1",
        digest("admin_auth.create_verification_token", {
          identifier: "operator@example.test",
          token: "race-verification-token",
          expires: expires.toISOString(),
        }),
      ),
      identifier: "Operator@Example.Test",
      token: "race-verification-token",
      expires: timestampFromDate(expires),
    });
    const [left, right] = await Promise.all([
      service.createVerificationToken(request, {} as never),
      service.createVerificationToken(request, {} as never),
    ]);
    expect(left.receipt).toEqual(right.receipt);
    expect(await prisma.verificationToken.count({ where: { token: "race-verification-token" } })).toBe(1);
    expect(await prisma.adminAuthCommandReceipt.count({ where: { commandId: "create-race-1" } })).toBe(1);
  });
});
