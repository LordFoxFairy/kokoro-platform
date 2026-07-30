import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AdminOidcService,
  OidcProviderOutcomeUnknownError,
  type AdminOidcStore,
  type AdminOidcTransaction,
} from "../../src/modules/admin/application/services/admin-oidc-service.js";

const clock = () => new Date("2026-07-29T15:00:00.000Z");
const axes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web/admin",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:managed:1",
  audience: "platform-admin",
});

describe("Platform-owned Admin OIDC", () => {
  it("creates a short single-use Authorization Code+PKCE transaction without disclosing verifier or nonce", async () => {
    const harness = oidcHarness();
    const result = await harness.service.begin({
      commandId: "command:begin:1",
      idempotencyKey: "begin-key-1",
      requestDigest: "a".repeat(64),
      axes,
      returnIntentRef: "dashboard",
      recoveryHandle: Buffer.alloc(32, 7),
    });

    expect(result.authorizationUri).toContain("code_challenge=challenge-1");
    expect(result.authorizationUri).toContain("nonce=nonce-0001");
    expect(result.authorizationUri).toContain("state=oidc-transaction:1");
    expect(JSON.stringify(result)).not.toContain("verifier-1");
    expect(harness.transactions[0]).toMatchObject({
      state: "pending",
      pkceVerifierCiphertext: "sealed:verifier-1",
      pkceChallenge: "challenge-1",
      nonceCiphertext: "sealed:nonce-0001",
      recoveryDigest: digest(Buffer.alloc(32, 7)),
      exactCallbackUri: "https://admin.example.test/auth/callback",
      issuer: "https://issuer.example.test",
      clientId: "admin-client",
      oidcAudience: "admin-audience",
      signingKeyRevision: "signing-1",
      deliveryKeyRevision: "delivery-1",
    });
  });

  it("redeems the code once and recovers the byte-identical committed delivery without IdP access", async () => {
    const harness = oidcHarness();
    const recoveryHandle = Buffer.alloc(32, 9);
    const begin = await harness.service.begin({
      commandId: "command:begin:2",
      idempotencyKey: "begin-key-2",
      requestDigest: "b".repeat(64),
      axes,
      returnIntentRef: "dashboard",
      recoveryHandle,
    });
    const first = await harness.service.exchange({
      commandId: "command:exchange:2",
      idempotencyKey: "exchange-key-2",
      requestDigest: "c".repeat(64),
      axes,
      transactionRef: begin.transactionRef,
      authorizationCode: "authorization-code-2",
      recoveryHandle,
    });
    const recovered = await harness.service.getDelivery({
      requestId: "request:recovery:2",
      axes,
      transactionRef: begin.transactionRef,
      recoveryHandle,
    });
    const retry = await harness.service.exchange({
      commandId: "command:exchange:2",
      idempotencyKey: "exchange-key-2",
      requestDigest: "c".repeat(64),
      axes,
      transactionRef: begin.transactionRef,
      authorizationCode: "authorization-code-2",
      recoveryHandle,
    });

    expect(harness.redeem).toHaveBeenCalledTimes(1);
    expect(first.deliveryEnvelope).toBe("sealed-delivery:operator-session:1");
    expect(recovered).toEqual(first);
    expect(retry).toEqual(first);
    expect(harness.transactions[0]).toMatchObject({
      state: "committed",
      sessionRef: "operator-session:1",
      deliveryEnvelope: first.deliveryEnvelope,
    });
  });

  it("stabilizes an ambiguous token endpoint outcome as restart-login and never redeems again", async () => {
    const harness = oidcHarness({ redeemError: new OidcProviderOutcomeUnknownError() });
    const recoveryHandle = Buffer.alloc(32, 3);
    const begin = await harness.service.begin({
      commandId: "command:begin:3",
      idempotencyKey: "begin-key-3",
      requestDigest: "d".repeat(64),
      axes,
      returnIntentRef: "dashboard",
      recoveryHandle,
    });
    const exchange = () => harness.service.exchange({
      commandId: "command:exchange:3",
      idempotencyKey: "exchange-key-3",
      requestDigest: "e".repeat(64),
      axes,
      transactionRef: begin.transactionRef,
      authorizationCode: "authorization-code-3",
      recoveryHandle,
    });

    await expect(exchange()).rejects.toThrow("ADMIN_OIDC_RESTART_LOGIN_REQUIRED");
    await expect(exchange()).rejects.toThrow("ADMIN_OIDC_RESTART_LOGIN_REQUIRED");
    await expect(harness.service.getDelivery({
      requestId: "request:recovery:3",
      axes,
      transactionRef: begin.transactionRef,
      recoveryHandle,
    })).rejects.toThrow("ADMIN_SESSION_DELIVERY_NOT_FOUND");
    expect(harness.redeem).toHaveBeenCalledTimes(1);
    expect(harness.transactions[0]?.state).toBe("provider_outcome_unknown");
  });

  it("terminalizes a definitive provider rejection and never retries the authorization code", async () => {
    const harness = oidcHarness({ redeemError: new Error("OIDC_CODE_REJECTED") });
    const recoveryHandle = Buffer.alloc(32, 4);
    const begin = await harness.service.begin({
      commandId: "command:begin:rejected",
      idempotencyKey: "begin-key-rejected",
      requestDigest: "9".repeat(64),
      axes,
      returnIntentRef: "dashboard",
      recoveryHandle,
    });
    const exchange = () => harness.service.exchange({
      commandId: "command:exchange:rejected",
      idempotencyKey: "exchange-key-rejected",
      requestDigest: "8".repeat(64),
      axes,
      transactionRef: begin.transactionRef,
      authorizationCode: "authorization-code-rejected",
      recoveryHandle,
    });

    await expect(exchange()).rejects.toThrow("ADMIN_OIDC_LOGIN_REJECTED");
    await expect(exchange()).rejects.toThrow("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
    expect(harness.redeem).toHaveBeenCalledTimes(1);
    expect(harness.transactions[0]?.state).toBe("rejected");
  });

  it("fails closed when workload axes, nonce, issuer, audience, device or operator authority drift", async () => {
    const harness = oidcHarness();
    const recoveryHandle = Buffer.alloc(32, 5);
    const begin = await harness.service.begin({
      commandId: "command:begin:4",
      idempotencyKey: "begin-key-4",
      requestDigest: "f".repeat(64),
      axes,
      returnIntentRef: "dashboard",
      recoveryHandle,
    });

    await expect(harness.service.exchange({
      commandId: "command:exchange:4",
      idempotencyKey: "exchange-key-4",
      requestDigest: "1".repeat(64),
      axes: { ...axes, region: "eu-west-1" },
      transactionRef: begin.transactionRef,
      authorizationCode: "authorization-code-4",
      recoveryHandle,
    })).rejects.toThrow("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
    expect(harness.redeem).not.toHaveBeenCalled();
  });
});

function oidcHarness(input: Readonly<{ redeemError?: Error }> = {}) {
  const transactions: AdminOidcTransaction[] = [];
  const store: AdminOidcStore = {
    async create(transaction) {
      transactions.push({ ...transaction });
      return transaction;
    },
    async find(transactionRef) {
      return transactions.find((value) => value.transactionRef === transactionRef) ?? null;
    },
    async claimExchange(transactionRef, request) {
      const value = transactions.find((candidate) => candidate.transactionRef === transactionRef);
      if (!value || value.state !== "pending") return value ?? null;
      Object.assign(value, {
        state: "redeeming",
        exchangeCommandId: request.commandId,
        exchangeIdempotencyKey: request.idempotencyKey,
        exchangeRequestDigest: request.requestDigest,
      });
      return { ...value };
    },
    async markProviderOutcomeUnknown(transactionRef) {
      const value = requiredTransaction(transactions, transactionRef);
      value.state = "provider_outcome_unknown";
    },
    async markRejected(transactionRef) {
      const value = requiredTransaction(transactions, transactionRef);
      value.state = "rejected";
    },
    async commitExchange(transactionRef, commit) {
      const value = requiredTransaction(transactions, transactionRef);
      Object.assign(value, commit, { state: "committed" });
      return { ...value };
    },
  };
  const redeem = vi.fn(async () => {
    if (input.redeemError) throw input.redeemError;
    return {
      issuer: "https://issuer.example.test",
      subject: "oidc-subject:1",
      audience: "admin-audience",
      nonce: "nonce-0001",
      authenticationTime: "2026-07-29T14:59:00.000Z",
      assuranceLevel: "phishing_resistant" as const,
      factorClasses: ["oidc", "webauthn"],
      managedDeviceRef: "device:managed:1",
    };
  });
  const service = new AdminOidcService({
    store,
    provider: {
      authorizationUri: ({ codeChallenge, nonce, state }) =>
        `https://issuer.example.test/authorize?code_challenge=${codeChallenge}&nonce=${nonce}&state=${state}`,
      redeem,
    },
    registration: {
      resolve: () => ({
        issuer: "https://issuer.example.test",
        clientId: "admin-client",
        oidcAudience: "admin-audience",
        exactCallbackUri: "https://admin.example.test/auth/callback",
        returnIntentRefs: ["dashboard"],
        signingKeyRevision: "signing-1",
        deliveryKeyRevision: "delivery-1",
      }),
    },
    protector: {
      seal: (value) => `sealed:${value}`,
      open: (value) => value.slice("sealed:".length),
    },
    recoveryDigester: digest,
    credentialDigester: (value) => createHash("sha256")
      .update("kokoro.admin-session-credential.v1\0", "utf8").update(value).digest("hex"),
    operator: {
      resolve: async () => ({
        operatorRef: "operator:1",
        operatorGeneration: 2n,
        operatorSecurityEpoch: 4n,
        restrictionEpoch: 6n,
        policyEpoch: 8n,
      }),
    },
    delivery: {
      seal: async ({ sessionRef }) => `sealed-delivery:${sessionRef}`,
    },
    references: (() => {
      let index = 0;
      return () => ["oidc-transaction:1", "operator-session:1"][index++]!;
    })(),
    credential: () => "opaque-credential-256-bit-test-value",
    secrets: () => ({
      verifier: "verifier-1",
      challenge: "challenge-1",
      nonce: "nonce-0001",
    }),
    clock,
  });
  return { service, transactions, redeem };
}

function requiredTransaction(
  transactions: AdminOidcTransaction[],
  transactionRef: string,
): AdminOidcTransaction {
  const value = transactions.find((candidate) => candidate.transactionRef === transactionRef);
  if (!value) throw new Error("missing transaction");
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256")
    .update("kokoro.admin-session-recovery.v1", "utf8")
    .update(value)
    .digest("hex");
}
