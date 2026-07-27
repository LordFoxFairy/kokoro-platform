import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdminAuthService } from "../../src/admin-auth-service.js";
import { makePrismaAdminAuthStore } from "../../src/admin-auth-store.js";
import {
  canonicalizeConsumeVerificationTokenEffect,
  canonicalizeCreateVerificationTokenEffect,
  canonicalizeRecordAuthEventEffect,
  consumeVerificationTokenEffectDigest,
  createVerificationTokenEffectDigest,
  recordAuthEventEffectDigest,
} from "../../src/generated/contracts/admin-auth-effect-digest.js";
import { CommandDigestAlgorithm } from "../../src/generated/contracts/kokoro/common/v1/receipt_pb.js";
import {
  AuthEventKind,
  ConsumeVerificationTokenEffectSchema,
  ConsumeVerificationTokenRequestSchema,
  CreateVerificationTokenEffectSchema,
  CreateVerificationTokenRequestSchema,
  RecordAuthEventEffectSchema,
  RecordAuthEventRequestSchema,
} from "../../src/generated/contracts/kokoro/platform/admin/v1/admin_auth_pb.js";
import { createAdminPrisma } from "../../src/prisma.js";

// 这组用例会清空 operator/auth 全部表再落回执，所以只允许打本机一次性隔离库。
// 该保护原本是 describe.skipIf：环境不对时 5 条一条不跑却仍报绿，真实覆盖为零。
// 改为 fail-loud——缺什么直接说，让「跑了多少条」这个数字可信。
// 错误信息只暴露 host 与库名，绝不回显含密码的完整 URL。
function requireIsolatedAdminDatabase(): string {
  const url = process.env.DATABASE_URL_ADMIN;
  if (url === undefined || url === "") {
    throw new Error(
      "DATABASE_URL_ADMIN is required for Admin Auth Prisma integration tests. " +
        "Point it at an isolated local database: " +
        "DATABASE_URL_ADMIN=mysql://root:<password>@127.0.0.1:3307/kokoro_admin_verify",
    );
  }

  let host: string;
  let database: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    database = parsed.pathname.replace(/^\//, "");
  } catch {
    throw new Error("DATABASE_URL_ADMIN is not a valid URL; expected mysql://<user>:<password>@<host>:<port>/<database>");
  }

  if ((host !== "127.0.0.1" && host !== "localhost") || database !== "kokoro_admin_verify") {
    throw new Error(
      "Admin Auth Prisma integration tests truncate operator/auth tables, so they refuse to run outside an isolated " +
        `local database. Expected host 127.0.0.1 or localhost and database "kokoro_admin_verify", got host "${host}" ` +
        `and database "${database}". Create and migrate it first: ` +
        "DATABASE_URL_ADMIN=mysql://root:<password>@127.0.0.1:3307/kokoro_admin_verify pnpm --filter @kokoro/platform-admin db:migrate",
    );
  }
  return url;
}

describe("Admin Auth Prisma receipts", () => {
  const prisma = createAdminPrisma(requireIsolatedAdminDatabase());
  const store = makePrismaAdminAuthStore(prisma);
  const now = new Date("2030-01-02T03:04:05.000Z");
  const expires = new Date("2030-01-02T03:14:05.000Z");
  const service = createAdminAuthService(store, { now: () => now });

  function command(commandId: string, requestDigest: string) {
    return {
      commandId,
      idempotencyKey: `idempotency-${commandId}`,
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest,
    };
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
    const effect = canonicalizeCreateVerificationTokenEffect(
      create(CreateVerificationTokenEffectSchema, {
        identifier: "Operator@Example.Test",
        token: "raw-verification-token",
        expires: timestampFromDate(expires),
      }),
    );
    const requestDigest = createVerificationTokenEffectDigest(effect);
    const request = create(CreateVerificationTokenRequestSchema, {
      command: command("create-db-1", requestDigest),
      effect,
    });
    const first = await service.createVerificationToken(request, {} as never);
    const replay = await service.createVerificationToken(request, {} as never);
    const reconciled = await service.getCommandReceipt(
      {
        commandId: "create-db-1",
        digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
        requestDigest,
      } as never,
      {} as never,
    );
    expect(replay.receipt).toEqual(first.receipt);
    expect(await prisma.verificationToken.count()).toBe(1);
    expect(await prisma.adminAuthCommandReceipt.count()).toBe(1);
    expect(JSON.stringify(await prisma.adminAuthCommandReceipt.findMany())).not.toContain("raw-verification-token");
    expect(reconciled.result?.case).toBe("verificationToken");
  });

  it("rejects digest mismatch before another effect", async () => {
    const effect = canonicalizeCreateVerificationTokenEffect(
      create(CreateVerificationTokenEffectSchema, {
        identifier: "operator@example.test",
        token: "different-token",
        expires: timestampFromDate(expires),
      }),
    );
    const mismatched = create(CreateVerificationTokenRequestSchema, {
      command: command("create-db-1", createVerificationTokenEffectDigest(effect)),
      effect,
    });
    await expect(Promise.resolve(service.createVerificationToken(mismatched, {} as never))).rejects.toMatchObject({
      domainCode: "command.digest_conflict",
    });
    expect(await prisma.verificationToken.count()).toBe(1);
  });

  it("rolls back a failed consume receipt and atomically replays a successful consume", async () => {
    const missingEffect = canonicalizeConsumeVerificationTokenEffect(
      create(ConsumeVerificationTokenEffectSchema, {
        identifier: "operator@example.test",
        token: "missing-token",
      }),
    );
    const missing = create(ConsumeVerificationTokenRequestSchema, {
      command: command("consume-missing", consumeVerificationTokenEffectDigest(missingEffect)),
      effect: missingEffect,
    });
    await expect(Promise.resolve(service.consumeVerificationToken(missing, {} as never))).rejects.toMatchObject({
      domainCode: "verification_token.not_found",
    });
    expect(await prisma.adminAuthCommandReceipt.findUnique({ where: { commandId: "consume-missing" } })).toBeNull();

    const effect = canonicalizeConsumeVerificationTokenEffect(
      create(ConsumeVerificationTokenEffectSchema, {
        identifier: "operator@example.test",
        token: "raw-verification-token",
      }),
    );
    const request = create(ConsumeVerificationTokenRequestSchema, {
      command: command("consume-db-1", consumeVerificationTokenEffectDigest(effect)),
      effect,
    });
    const first = await service.consumeVerificationToken(request, {} as never);
    const replay = await service.consumeVerificationToken(request, {} as never);
    expect(replay.receipt).toEqual(first.receipt);
    expect(await prisma.verificationToken.count()).toBe(0);
    expect(await prisma.adminAuthCommandReceipt.count({ where: { commandId: "consume-db-1" } })).toBe(1);
  });

  it("deduplicates an auth event through the same command receipt", async () => {
    const effect = canonicalizeRecordAuthEventEffect(
      create(RecordAuthEventEffectSchema, {
        email: "Operator@Example.Test",
        event: AuthEventKind.SIGN_IN,
        occurredAt: timestampFromDate(now),
      }),
    );
    const request = create(RecordAuthEventRequestSchema, {
      command: command("event-db-1", recordAuthEventEffectDigest(effect)),
      effect,
    });
    await service.recordAuthEvent(request, {} as never);
    await service.recordAuthEvent(request, {} as never);
    expect(await prisma.authEvent.count()).toBe(1);
    expect(await prisma.adminAuthCommandReceipt.count({ where: { commandId: "event-db-1" } })).toBe(1);
  });

  it("serializes simultaneous same-command writers through one effect and receipt", async () => {
    const effect = canonicalizeCreateVerificationTokenEffect(
      create(CreateVerificationTokenEffectSchema, {
        identifier: "Operator@Example.Test",
        token: "race-verification-token",
        expires: timestampFromDate(expires),
      }),
    );
    const request = create(CreateVerificationTokenRequestSchema, {
      command: command("create-race-1", createVerificationTokenEffectDigest(effect)),
      effect,
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
