import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BootstrapVerifiedPersonalAccountService,
  type BootstrapVerifiedPersonalAccountDependencies,
  type BootstrapVerifiedPersonalAccountInput,
} from "../../src/modules/identity/application/services/bootstrap-verified-personal-account.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { JsonValue } from "../../src/shared/outbox-inbox/receipt.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const refs = Object.freeze({
  accountRef: "00000000-0000-7000-8000-000000000001",
  subjectRef: "subject:owner",
  workspaceRef: "workspace:owner",
  projectRef: "project:owner",
  billingAccountRef: "billing:owner",
  executionSpaceRef: "execution:owner",
  executionNamespace: "namespace_owner",
  verificationTransactionRef: "00000000-0000-7000-8000-000000000002",
  namespaceIntentRef: "00000000-0000-7000-8000-000000000003",
  namespaceEventId: "00000000-0000-7000-8000-000000000004",
});

function input(change: Partial<BootstrapVerifiedPersonalAccountInput> = {}): BootstrapVerifiedPersonalAccountInput {
  return {
    commandId: "00000000-0000-4000-8000-000000000010",
    idempotencyKey: "core-bootstrap:identity",
    requestDigest: digest("config"),
    siteRef: "site:core",
    email: "Owner@Example.Test",
    password: "correct horse battery staple",
    displayName: "Core owner",
    ...refs,
    ...change,
  };
}

async function context(kind: "admin_workload" | "site_product" = "admin_workload") {
  const now = "2026-08-11T00:00:00.000Z";
  const raw = {
    trustedCaller: {
      workloadIdentityId: "spiffe://kokoro/admin/bootstrap", kind,
      audience: "platform-bootstrap", environment: "production", region: "us-east-1",
      allowedOperations: ["identity.bootstrap-verified-personal-account"], siteId: "site:core",
      bindingEpoch: "1", issuedAt: now, expiresAt: "2026-08-12T00:00:00.000Z",
      ...(kind === "site_product" ? { siteReleaseRef: "release:core", siteSecurityEpoch: "1" } : {}),
    },
    requestId: "request:1", correlationId: "correlation:1",
    actor: { kind: "operator", subjectId: "operator:maker", subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId: "site:core", workspaceId: null, projectId: null,
      purpose: "bootstrap", scopes: ["site:core"] },
    audience: "platform-bootstrap", environment: "production", region: "us-east-1",
    evidence: [{ kind: "test", evidenceId: "evidence:1", issuer: "test-issuer" }],
    policyEpoch: "1", issuedAt: now, expiresAt: "2026-08-12T00:00:00.000Z",
  };
  return verifyRequestSecurityContext(raw, { now, operation: "identity.bootstrap-verified-personal-account",
    expectedAudience: "platform-bootstrap", expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { async verify() { return { ...raw.trustedCaller, issuer: "test-issuer", keyVersion: "1" }; } } });
}

function setup(options: { duplicate?: boolean } = {}) {
  const effects: string[] = [];
  let receipt: { state: "pending" | "succeeded"; result: JsonValue | null; requestDigest: string } =
    { state: "pending", result: null, requestDigest: digest("config") };
  const dependencies: BootstrapVerifiedPersonalAccountDependencies = {
    unitOfWork: { async execute(_fence, work) {
      effects.push("transaction");
      return work({ kind: "platform_transaction" } as never);
    } },
    repository: {
      async createVerification() { effects.push("verification"); return options.duplicate ? "undisclosed" : "created"; },
      async activateVerification(_transaction, activate) {
        effects.push("activate");
        return {
          subject: { siteRef: activate.siteRef, subjectRef: activate.subjectRef, state: "active",
            subjectGeneration: "1", restrictionEpoch: "1", updatedAt: activate.now,
            retainUntil: "2026-08-11T00:05:00.000Z" },
          membership: { siteRef: activate.siteRef, subjectRef: activate.subjectRef,
            projectRef: activate.projectRef, state: "active", membershipEpoch: "1",
            authorizationEpoch: "1", updatedAt: activate.now, retainUntil: "2026-08-11T00:05:00.000Z" },
        };
      },
    },
    receipts: {
      async begin(_transaction, identity) {
        if (receipt.requestDigest !== identity.requestDigest) throw new Error("COMMAND_DIGEST_CONFLICT");
        return { ...identity, state: receipt.state, result: receipt.result, resultDigest: null };
      },
      async recordOutcome(_transaction, identity, outcome) {
        receipt = { state: "succeeded", result: outcome.result, requestDigest: identity.requestDigest };
        return { ...identity, state: "succeeded", result: outcome.result, resultDigest: outcome.resultDigest };
      },
    },
    passwordHasher: { async hash() { effects.push("password"); return { passwordHash: "$argon2id$hash", pepperVersion: 1 }; },
      async verify() { return true; } },
    authorizationMutation: { async execute(_transaction, _input, mutate) {
      effects.push("authorization"); return mutate();
    } },
    outbox: { async enqueue(_transaction, event) { effects.push(`event:${event.eventType}`); } },
    auditDigest(value) { return digest(JSON.stringify(value)); },
    clock: () => new Date("2026-08-11T00:00:00.000Z"),
  };
  return { service: new BootstrapVerifiedPersonalAccountService(dependencies), effects, dependencies };
}

describe("BootstrapVerifiedPersonalAccountService", () => {
  it("atomically creates a verified personal owner and one namespace allocation event", async () => {
    const { service, effects } = setup();
    const result = await service.bootstrap(input(), await context());
    expect(result).toEqual({ accountRef: refs.accountRef, subjectRef: refs.subjectRef,
      workspaceRef: refs.workspaceRef, projectRef: refs.projectRef,
      billingAccountRef: refs.billingAccountRef, executionSpaceRef: refs.executionSpaceRef,
      executionNamespace: refs.executionNamespace });
    expect(effects).toEqual(["password", "transaction", "verification", "authorization",
      "event:identity.namespace.allocation.requested", "activate"]);
    expect(effects.some((item) => item.includes("verification.delivery"))).toBe(false);
  });

  it("returns the owner-safe receipt result on same-command replay without owner effects", async () => {
    const { service, effects } = setup();
    const verified = await context();
    const first = await service.bootstrap(input(), verified);
    effects.length = 0;
    expect(await service.bootstrap(input(), verified)).toEqual(first);
    expect(effects).toEqual(["password", "transaction"]);
  });

  it("rejects a non-admin caller before hashing or opening a transaction", async () => {
    const { service, effects } = setup();
    await expect(service.bootstrap(input(), await context("site_product")))
      .rejects.toThrow("IDENTITY_BOOTSTRAP_ADMIN_REQUIRED");
    expect(effects).toEqual([]);
  });

  it("fails duplicate email and leaves transaction rollback to the shared unit of work", async () => {
    const { service, effects } = setup({ duplicate: true });
    await expect(service.bootstrap(input(), await context()))
      .rejects.toThrow("IDENTITY_BOOTSTRAP_ACCOUNT_CONFLICT");
    expect(effects).not.toContain("activate");
  });

  it("fails closed when the same command is replayed with email, password digest, or reference drift", async () => {
    const { service, dependencies } = setup();
    const verified = await context();
    await service.bootstrap(input(), verified);
    const hash = vi.spyOn(dependencies.passwordHasher, "hash");
    await expect(service.bootstrap(input({ requestDigest: digest("changed") }), verified))
      .rejects.toThrow("COMMAND_DIGEST_CONFLICT");
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("requires an actually verified context", async () => {
    const { service } = setup();
    await expect(service.bootstrap(input(), { trustedCaller: { kind: "admin_workload" }, actor: { kind: "operator" } } as VerifiedRequestSecurityContext))
      .rejects.toThrow("REQUEST_SECURITY_CONTEXT_NOT_VERIFIED");
  });
});
