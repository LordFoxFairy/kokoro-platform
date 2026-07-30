import { describe, expect, it } from "vitest";
import {
  PostgresAdminOidcStore,
  type AdminIdentityTransactionHost,
} from "../../src/modules/admin/infrastructure/postgres/admin-oidc-store.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import type { AdminOidcTransaction } from
  "../../src/modules/admin/application/services/admin-oidc-service.js";

const axes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web/admin",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:managed:1",
  audience: "platform-admin",
});

describe("Postgres Admin OIDC store", () => {
  it("creates a transaction only inside the exact verified workload fence", async () => {
    const harness = postgresHarness([transactionRow()]);
    const store = new PostgresAdminOidcStore(harness.host);

    await expect(store.create(transaction())).resolves.toMatchObject({
      transactionRef: "018f1212-1212-7212-8212-121212121212",
      state: "pending",
    });
    expect(harness.fences).toEqual([{ operation: "admin.identity.begin", ...axes }]);
    expect(harness.statements[0]).toContain("INSERT INTO platform.admin_oidc_transaction");
    expect(harness.values[0]).not.toContain("verifier-plaintext");
  });

  it("claims pending exchange once and freezes the exact command digest", async () => {
    const harness = postgresHarness([{ ...transactionRow(), state: "redeeming",
      exchangeCommandId: "command:exchange:1", exchangeIdempotencyKey: "exchange-key-1",
      exchangeRequestDigest: "c".repeat(64), createdAt: new Date(), updatedAt: new Date() }]);
    const store = new PostgresAdminOidcStore(harness.host);

    await store.claimExchange("018f1212-1212-7212-8212-121212121212", {
      commandId: "command:exchange:1",
      idempotencyKey: "exchange-key-1",
      requestDigest: "c".repeat(64),
    }, axes);

    expect(harness.fences).toEqual([{ operation: "admin.identity.exchange", ...axes }]);
    expect(harness.statements[0]).toContain("WHERE transaction_ref=$1::uuid AND state='pending'");
    expect(harness.statements[0]).toContain("RETURNING");
  });

  it("atomically inserts the credential digest and commits the exact delivery envelope", async () => {
    const committed = {
      ...transactionRow(),
      state: "committed",
      exchangeCommandId: "command:exchange:1",
      exchangeIdempotencyKey: "exchange-key-1",
      exchangeRequestDigest: "c".repeat(64),
      sessionRef: "018f1313-1313-7313-8313-131313131313",
      sessionExpiresAt: "2026-07-29T15:15:00.000Z",
      deliveryExpiresAt: "2026-07-29T15:02:00.000Z",
      deliveryEnvelope: "compact-jwe",
      exchangeReceipt: receipt(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const harness = postgresHarness([committed]);
    const store = new PostgresAdminOidcStore(harness.host);

    await store.commitExchange("018f1212-1212-7212-8212-121212121212", {
      sessionRef: "018f1313-1313-7313-8313-131313131313",
      sessionExpiresAt: "2026-07-29T15:15:00.000Z",
      deliveryExpiresAt: "2026-07-29T15:02:00.000Z",
      deliveryEnvelope: "compact-jwe",
      exchangeReceipt: receipt(),
      credentialDigest: "f".repeat(64),
      operatorRef: "operator:1",
      operatorGeneration: 2n,
      operatorSecurityEpoch: 4n,
      restrictionEpoch: 6n,
      policyEpoch: 8n,
      assuranceLevel: "phishing_resistant",
      factorClasses: ["oidc", "webauthn"],
      authenticatedAt: "2026-07-29T14:59:00.000Z",
    }, axes);

    expect(harness.statements).toHaveLength(2);
    expect(harness.statements[0]).toContain("INSERT INTO platform.admin_operator_session");
    expect(harness.statements[1]).toContain("UPDATE platform.admin_oidc_transaction");
    expect(harness.statements[1]).toContain("state='redeeming'");
    expect(harness.values[0]).toContain("f".repeat(64));
    expect(harness.values.flat()).not.toContain("opaque-session-credential");
  });
});

function postgresHarness(rows: readonly Record<string, unknown>[]) {
  const fences: unknown[] = [];
  const statements: string[] = [];
  const values: readonly unknown[][] = [];
  const host: AdminIdentityTransactionHost = {
    async adminIdentityTransaction(fence, work) {
      fences.push(fence);
      const lease = issuePlatformTransaction({
        async query<Row extends Record<string, unknown>>(statement: string, currentValues: readonly unknown[] = []) {
          statements.push(statement);
          (values as unknown[][]).push(currentValues as unknown[]);
          return rows as readonly Row[];
        },
        async execute(statement, currentValues = []) {
          statements.push(statement);
          (values as unknown[][]).push(currentValues as unknown[]);
          return 1;
        },
      });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  };
  return { host, fences, statements, values };
}

function transaction(): AdminOidcTransaction {
  return {
    transactionRef: "018f1212-1212-7212-8212-121212121212",
    state: "pending",
    beginCommandId: "command:begin:1",
    beginIdempotencyKey: "begin-key-1",
    beginRequestDigest: "a".repeat(64),
    axes,
    returnIntentRef: "dashboard",
    issuer: "https://issuer.example.test",
    clientId: "admin-client",
    oidcAudience: "admin-audience",
    exactCallbackUri: "https://admin.example.test/auth/callback",
    pkceVerifierCiphertext: "protected-verifier",
    pkceChallenge: "challenge-0001",
    nonceCiphertext: "protected-nonce",
    stateDigest: "d".repeat(64),
    recoveryDigest: "e".repeat(64),
    signingKeyRevision: "signing-1",
    deliveryKeyRevision: "delivery-1",
    expiresAt: "2026-07-29T15:05:00.000Z",
    recoveryExpiresAt: "2026-07-29T15:10:00.000Z",
  };
}

function transactionRow(): Record<string, unknown> {
  const value = transaction();
  const { axes: workloadAxes, ...row } = value;
  return {
    ...row,
    ...workloadAxes,
    exchangeCommandId: null,
    exchangeIdempotencyKey: null,
    exchangeRequestDigest: null,
    operatorSessionRef: null,
    deliveryEnvelope: null,
    exchangeReceipt: null,
    deliveryExpiresAt: null,
  };
}

function receipt() {
  return {
    commandId: "command:exchange:1",
    idempotencyKey: "exchange-key-1",
    requestDigest: "c".repeat(64),
    operation: "admin.identity.exchange" as const,
    state: "committed" as const,
    recordedAt: "2026-07-29T15:00:00.000Z",
  };
}
