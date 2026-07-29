import { describe, expect, it } from "vitest";
import { CommerceCommandFence } from "../../src/modules/commerce/application/command-fence.js";
import type { CommerceRepository } from "../../src/modules/commerce/application/contracts/repository.js";
import { PlatformUnitOfWork, type PlatformTransactionHost } from "../../src/shared/unit-of-work/unit-of-work.js";
import { issuePlatformTransaction, revokePlatformTransaction, type PlatformSqlTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";

describe("CommerceCommandFence", () => {
  it("claims the idempotency identity before effect authorization and every business lock", async () => {
    const calls: string[] = [];
    const repository = {
      claimCommand: async () => { calls.push("identity"); return { disposition: "execute", commandId: "0123456789abcdef0123456789abcdef" }; },
      completeCommand: async () => { calls.push("result"); },
    } as unknown as CommerceRepository;
    const fence = new CommerceCommandFence(unitOfWork(), repository, async () => {
      calls.push("effect-auth");
      return { siteId: "site-1", releaseRef: "release-1", subjectId: "user-1" };
    });

    await fence.execute({ context: await context(), identity: identity() }, async ({ locks }) => {
      locks.enter("program_availability");
      calls.push("program-lock");
      locks.enter("billing_account");
      calls.push("account-lock");
      return { state: "succeeded", result: { ok: true }, resultDigest: "b".repeat(64) };
    });

    expect(calls).toEqual(["identity", "effect-auth", "program-lock", "account-lock", "result"]);
  });

  it("returns a terminal replay without effect authorization or business work", async () => {
    const calls: string[] = [];
    const repository = {
      claimCommand: async () => ({ disposition: "replay", commandId: identity().commandId, receipt: { state: "succeeded", result: { ok: true }, resultDigest: "b".repeat(64) } }),
    } as unknown as CommerceRepository;
    const fence = new CommerceCommandFence(unitOfWork(), repository, async () => { calls.push("effect-auth"); throw new Error("NO"); });
    const result = await fence.execute({ context: await context(), identity: identity() }, async () => { calls.push("work"); throw new Error("NO"); });
    expect(result).toMatchObject({ disposition: "replay", receipt: { state: "succeeded" } });
    expect(calls).toEqual([]);
  });

  it("rejects an inverted business lock order", async () => {
    const repository = {
      claimCommand: async () => ({ disposition: "execute", commandId: identity().commandId }),
      completeCommand: async () => undefined,
    } as unknown as CommerceRepository;
    const fence = new CommerceCommandFence(unitOfWork(), repository, async () => ({ siteId: "site-1", releaseRef: "release-1", subjectId: "user-1" }));
    await expect(fence.execute({ context: await context(), identity: identity() }, async ({ locks }) => {
      locks.enter("credit_account");
      locks.enter("billing_account");
      return { state: "succeeded", result: null, resultDigest: "b".repeat(64) };
    })).rejects.toThrow("COMMERCE_LOCK_ORDER_VIOLATION");
  });
});

function unitOfWork() {
  const sql: PlatformSqlTransaction = { query: async () => [], execute: async () => 0 };
  const host: PlatformTransactionHost = { transaction: async (_fence, work) => { const lease = issuePlatformTransaction(sql); try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); } } };
  return new PlatformUnitOfWork(host, () => "2026-07-28T00:05:00.000Z");
}

function identity() { return { commandId: "0123456789abcdef0123456789abcdef", environment: "production", region: "us-east-1", siteId: "site-1", actorKind: "user", actorSubject: "user-1", actorGeneration: "3", callerIdentity: "site:6:site-1|kind:4:user|actor:6:user-1|generation:1:3", operation: "confirmRedemption", idempotencyKey: "idem", commandVersion: "2026-07-28", requestDigest: "a".repeat(64) } as const; }

async function context() { return verifyRequestSecurityContext({ requestId: "req", correlationId: "corr", trustedCaller: { kind: "site_product", workloadIdentityId: "site-web-1", siteId: "site-1", siteReleaseRef: "release-1", siteSecurityEpoch: "7", environment: "production", region: "us-east-1", audience: "platform-public", allowedOperations: ["confirmRedemption"], bindingEpoch: "2", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }, actor: { kind: "user", subjectId: "user-1", subjectGeneration: "3", sessionId: "session-1", sessionEpoch: "4", restrictionEpoch: "5" }, delegatedGrant: null, target: { siteId: "site-1", workspaceId: null, projectId: null, purpose: "confirmRedemption", scopes: [] }, audience: "platform-public", environment: "production", region: "us-east-1", evidence: [{ kind: "csrf_verification", evidenceId: "c".repeat(64), issuer: "kokoro-platform-public" }, { kind: "workload_attestation", evidenceId: "attestation", issuer: "spiffe://kokoro.test" }], policyEpoch: "6", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z" }, { now: "2026-07-28T00:05:00.000Z", operation: "confirmRedemption", expectedAudience: "platform-public", expectedEnvironment: "production", expectedRegion: "us-east-1", callerVerifier: { verify: async () => ({ workloadIdentityId: "site-web-1", kind: "site_product", audience: "platform-public", environment: "production", region: "us-east-1", allowedOperations: ["confirmRedemption"], siteId: "site-1", siteReleaseRef: "release-1", siteSecurityEpoch: "7", bindingEpoch: "2", issuedAt: "2026-07-28T00:00:00.000Z", expiresAt: "2026-07-29T00:00:00.000Z", issuer: "spiffe://kokoro.test", keyVersion: "ca-1" }) } }); }
