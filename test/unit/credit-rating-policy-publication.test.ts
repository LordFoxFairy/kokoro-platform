import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RatingPolicyPublicationService } from
  "../../src/modules/credit/application/rating-policy-publication-service.js";
import { PostgresRatingPolicyPublicationRepository } from
  "../../src/modules/credit/infrastructure/postgres/rating-policy-publication-repository.js";
import type { RatingPolicyRevision } from "../../src/modules/credit/domain/usage-rating.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const migratorSource = readFileSync(new URL(
  "../../src/infrastructure/postgres/migrator.ts",
  import.meta.url,
), "utf8");

const publishedAt = "2026-08-05T12:00:00.000Z";
const policy: RatingPolicyRevision = Object.freeze({
  ratingPolicyRevisionRef: "rating-policy:chat-v1",
  customerUnit: "credit_micros",
  chargeableAttemptOutcomes: Object.freeze(["succeeded", "failed_after_effect"] as const),
  minimumAmount: 1n,
  rules: Object.freeze([
    Object.freeze({ dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1_000n,
      amountPerQuantum: 2n, required: true }),
    Object.freeze({ dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1_000n,
      amountPerQuantum: 4n, required: true }),
  ]),
});

describe("Credit rating-policy publication", () => {
  it("grants the Credit admin owner exact read/insert authority and audits it", () => {
    expect(migratorSource).toContain(
      "GRANT INSERT ON TABLE platform.credit_rating_policy_revision TO ${identifier}",
    );
    expect(migratorSource).toContain(
      "has_table_privilege(runtime_role.rolname, 'platform.credit_rating_policy_revision', 'SELECT')",
    );
    expect(migratorSource).toContain(
      "has_table_privilege(runtime_role.rolname, 'platform.credit_rating_policy_revision', 'INSERT')",
    );
    expect(migratorSource).not.toContain(
      "GRANT UPDATE ON TABLE platform.credit_rating_policy_revision",
    );
  });

  it("publishes a validated canonical policy through one Site-scoped owner UoW", async () => {
    const publish = vi.fn(async (_transaction, candidate) => Object.freeze({
      kind: "published" as const, publication: candidate,
    }));
    const unitOfWork = new PlatformUnitOfWork({
      async transaction(_fence, work) {
        const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
        try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
      },
    }, () => publishedAt);
    const service = new RatingPolicyPublicationService({ unitOfWork,
      repository: { publish }, clock: () => publishedAt });

    const result = await service.publish({ siteId: "site_01", policy }, await context());

    expect(result.kind).toBe("published");
    expect(publish).toHaveBeenCalledOnce();
    const candidate = publish.mock.calls[0]?.[1];
    expect(candidate).toMatchObject({ siteId: "site_01", state: "published", publishedAt,
      ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef, unit: policy.customerUnit });
    expect(candidate?.policyDocument).toEqual({
      ratingPolicyRevisionRef: "rating-policy:chat-v1",
      customerUnit: "credit_micros",
      chargeableAttemptOutcomes: ["succeeded", "failed_after_effect"],
      minimumAmount: "1",
      rules: [
        { dimensionKey: "input_tokens", sourceUnit: "token", quantum: "1000",
          amountPerQuantum: "2", required: true },
        { dimensionKey: "output_tokens", sourceUnit: "token", quantum: "1000",
          amountPerQuantum: "4", required: true },
      ],
    });
    expect(candidate?.policyDigest).toBe(createHash("sha256")
      .update(canonical(candidate?.policyDocument)).digest("hex"));
    expect(Object.isFrozen(candidate?.policyDocument)).toBe(true);
    expect(Object.isFrozen(candidate?.policyDocument.rules)).toBe(true);
  });

  it("rejects invalid policy rules before opening the owner transaction", async () => {
    const transaction = vi.fn();
    const service = new RatingPolicyPublicationService({
      unitOfWork: new PlatformUnitOfWork({ transaction }, () => publishedAt),
      repository: { publish: vi.fn() }, clock: () => publishedAt,
    });
    await expect(service.publish({ siteId: "site_01", policy: {
      ...policy, rules: [{ ...policy.rules[0]!, quantum: 0n }],
    } }, await context())).rejects.toThrow("CREDIT_RATING_POLICY_RULE_INVALID");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects an owner context for a different Site", async () => {
    const service = new RatingPolicyPublicationService({
      unitOfWork: new PlatformUnitOfWork({ transaction: vi.fn() }, () => publishedAt),
      repository: { publish: vi.fn() }, clock: () => publishedAt,
    });
    await expect(service.publish({ siteId: "site_other", policy }, await context()))
      .rejects.toThrow("CREDIT_RATING_POLICY_SITE_SCOPE_MISMATCH");
  });

  it("persists the only published immutable representation", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ query: async () => [],
      execute: async (statement, values = []) => { calls.push({ statement, values }); return 1; } });
    try {
      const result = await new PostgresRatingPolicyPublicationRepository()
        .publish(lease.transaction, publication());
      expect(result.kind).toBe("published");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.statement).toContain("INSERT INTO platform.credit_rating_policy_revision");
      expect(calls[0]?.statement).toContain("ON CONFLICT DO NOTHING");
      expect(calls[0]?.statement).not.toMatch(/UPDATE|DELETE/u);
      expect(calls[0]?.values).toContain("published");
    } finally { revokePlatformTransaction(lease); }
  });

  it("replays an exact Site/ref/digest publication after an insert conflict", async () => {
    const candidate = publication();
    const lease = issuePlatformTransaction({ execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => [{
        ratingPolicyRevisionRef: candidate.ratingPolicyRevisionRef,
        unit: candidate.unit, policy: candidate.policyDocument,
        policyDigest: candidate.policyDigest, state: "published", publishedAt,
      }] as unknown as readonly Row[] });
    try {
      await expect(new PostgresRatingPolicyPublicationRepository()
        .publish(lease.transaction, candidate)).resolves.toMatchObject({ kind: "replayed" });
    } finally { revokePlatformTransaction(lease); }
  });

  it("fails closed when the same Site/ref has drifted", async () => {
    const candidate = publication();
    const lease = issuePlatformTransaction({ execute: async () => 0,
      query: async <Row extends Record<string, unknown>>() => [{
        ratingPolicyRevisionRef: candidate.ratingPolicyRevisionRef,
        unit: candidate.unit, policy: { ...candidate.policyDocument, minimumAmount: "2" },
        policyDigest: "f".repeat(64), state: "published", publishedAt,
      }] as unknown as readonly Row[] });
    try {
      await expect(new PostgresRatingPolicyPublicationRepository()
        .publish(lease.transaction, candidate)).rejects
        .toThrow("CREDIT_RATING_POLICY_PUBLICATION_CONFLICT");
    } finally { revokePlatformTransaction(lease); }
  });
});

function publication() {
  const policyDocument = Object.freeze({
    ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef,
    customerUnit: policy.customerUnit,
    chargeableAttemptOutcomes: policy.chargeableAttemptOutcomes,
    minimumAmount: policy.minimumAmount.toString(),
    rules: Object.freeze(policy.rules.map((rule) => Object.freeze({ ...rule,
      quantum: rule.quantum.toString(), amountPerQuantum: rule.amountPerQuantum.toString() }))),
  });
  return Object.freeze({ siteId: "site_01", ratingPolicyRevisionRef: policy.ratingPolicyRevisionRef,
    unit: policy.customerUnit, policyDocument,
    policyDigest: createHash("sha256").update(canonical(policyDocument)).digest("hex"),
    state: "published" as const, publishedAt });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function context() {
  const operation = "credit.rating-policy.publish";
  const issuer = "spiffe://kokoro.test";
  const input = {
    requestId: "request-01", correlationId: "correlation-01",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "fixture-owner",
      environment: "production", region: "us-east-1", audience: "platform-admin",
      allowedOperations: [operation], bindingEpoch: "1", issuedAt: publishedAt,
      expiresAt: "2026-08-05T12:10:00.000Z" },
    actor: { kind: "operator", subjectId: "operator-01", subjectGeneration: "1" }, delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null,
      purpose: operation, scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01", issuer }],
    policyEpoch: "1", issuedAt: publishedAt, expiresAt: "2026-08-05T12:10:00.000Z",
  } as const;
  return verifyRequestSecurityContext(input, { now: publishedAt, operation,
    expectedAudience: "platform-admin", expectedEnvironment: "production", expectedRegion: "us-east-1",
    callerVerifier: { verify: async () => ({ workloadIdentityId: "fixture-owner", kind: "admin_workload",
      audience: "platform-admin", environment: "production", region: "us-east-1",
      allowedOperations: [operation], siteId: null, bindingEpoch: "1", issuedAt: publishedAt,
      expiresAt: "2026-08-05T12:10:00.000Z", issuer, keyVersion: "test-1" }) } });
}
