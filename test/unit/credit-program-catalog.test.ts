import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CreditProgramCatalogService } from
  "../../src/modules/commerce/application/credit-program-catalog-service.js";
import { PostgresCreditProgramCatalogReader } from
  "../../src/modules/commerce/infrastructure/postgres/credit-program-catalog-reader.js";
import { PostgresCreditProgramCatalog } from
  "../../src/modules/commerce/infrastructure/postgres/credit-program-catalog.js";
import { canonicalCreditProgramDefinitionFromBytes, encodeCreditProgramDefinition } from
  "../../src/modules/commerce/infrastructure/protobuf/credit-program-codec.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import {
  advanceCreditProgramCatalogSnapshot,
  defineCreditProgramRevision,
  type CreditProgramDefinition,
} from "../../src/modules/commerce/domain/credit-program-catalog.js";

const definition: CreditProgramDefinition = Object.freeze({
  unit: "credit_minor",
  grants: Object.freeze([
    Object.freeze({ bucket: "daily", amountMinor: 100n, burnPriority: 10,
      liabilityMerchantAccountRef: "merchant:platform", scopePolicy: scopePolicy(),
      window: Object.freeze({ kind: "daily", calendarZone: "America/New_York",
        resetSecondOfDay: 0, rolloverPolicy: "none" }) }),
    Object.freeze({ bucket: "permanent", amountMinor: 500n, burnPriority: 20,
      liabilityMerchantAccountRef: "merchant:platform", scopePolicy: scopePolicy(),
      window: Object.freeze({ kind: "permanent", expiresAfterSeconds: null }) }),
  ]),
  maximumProgramBalancePerAccountMinor: 10_000n,
  reservationTtlSeconds: 900n,
  reconciliationGraceSeconds: 3_600n,
  allowNegativeBalance: false,
  accountingPolicyRef: "accounting:standard-credit-v1",
});

describe("Commerce-owned global Program catalog", () => {
  it("commits the exact catalog mapping, not only reusable definition bytes", () => {
    const empty = `sha256:${createHash("sha256").update("").digest("hex")}`;
    const definitionDigest = `sha256:${"a".repeat(64)}`;
    const first = advanceCreditProgramCatalogSnapshot(empty, {
      programRef: "credit-program:starter", revision: 1n, revisionDigest: definitionDigest,
    });
    expect(advanceCreditProgramCatalogSnapshot(empty, {
      programRef: "credit-program:pro", revision: 1n, revisionDigest: definitionDigest,
    })).not.toBe(first);
    expect(advanceCreditProgramCatalogSnapshot(empty, {
      programRef: "credit-program:starter", revision: 2n, revisionDigest: definitionDigest,
    })).not.toBe(first);
  });

  it("generates an exact immutable target from supplied canonical definition bytes", () => {
    const bytes = encodeCreditProgramDefinition(definition);
    const revision = defineCreditProgramRevision({
      programRef: "credit-program:starter",
      revision: 2n,
      expectedVersion: 1n,
      canonicalDefinition: canonicalCreditProgramDefinitionFromBytes(bytes),
      publishedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(revision.target).toEqual({
      programRef: "credit-program:starter",
      revision: 2n,
      revisionDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
    expect(revision.exposure).toBe("inert");
    expect(revision.definitionBytes).not.toBe(bytes);
    expect(revision.definition).not.toHaveProperty("consumptionOrder");
    expect(revision.definition.maximumProgramBalancePerAccountMinor).toBe(10_000n);
  });

  it("rejects protobuf bytes that are not the unique known-field canonical encoding", () => {
    const canonical = encodeCreditProgramDefinition(definition);
    const withUnknownField = new Uint8Array([...canonical, 0xf8, 0x07, 0x01]);
    expect(() => canonicalCreditProgramDefinitionFromBytes(withUnknownField))
      .toThrow("CREDIT_PROGRAM_DEFINITION_BYTES_NON_CANONICAL");
  });

  it("does not expose mutable canonical bytes that can detach rules from their digest", () => {
    const bytes = encodeCreditProgramDefinition(definition);
    const canonical = canonicalCreditProgramDefinitionFromBytes(bytes);
    const exposed = canonical.definitionBytes;
    exposed[0] = (exposed[0] ?? 0) ^ 0xff;
    const revision = defineCreditProgramRevision({
      programRef: "credit-program:starter", revision: 1n, expectedVersion: 0n,
      canonicalDefinition: canonical, publishedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(revision.target.revisionDigest)
      .toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("uses a portable calendar-zone syntax gate instead of the host ICU acceptance set", () => {
    const hostIcu = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("host ICU must not decide persisted policy");
    });
    try {
      expect(() => encodeCreditProgramDefinition(definition)).not.toThrow();
    } finally {
      hostIcu.mockRestore();
    }
  });

  it.each([
    ["duplicate bucket", { ...definition, grants: [definition.grants[0]!, definition.grants[0]!] }],
    ["bucket/window mismatch", { ...definition, grants: [
      { ...definition.grants[0]!, bucket: "period" as const },
    ] }],
    ["daily zone has non-portable syntax", { ...definition, grants: [
      { ...definition.grants[0]!, window: { ...definition.grants[0]!.window,
        kind: "daily" as const, calendarZone: "not a zone" } },
    ] }],
    ["rollover is enabled", { ...definition, grants: [
      { ...definition.grants[0]!, window: { ...definition.grants[0]!.window,
        kind: "daily" as const, rolloverPolicy: "carry" } },
    ] }],
    ["negative balance", { ...definition, allowNegativeBalance: true }],
    ["short liability merchant reference", { ...definition, grants: [
      { ...definition.grants[0]!, liabilityMerchantAccountRef: "x" },
    ] }],
    ["aggregate grant exceeds the per-program account ceiling", { ...definition,
      maximumProgramBalancePerAccountMinor: 599n }],
    ["permanent expiry exceeds ten Julian years", { ...definition, grants: [
      { ...definition.grants[1]!, window: { kind: "permanent" as const,
        expiresAfterSeconds: 315_576_001n } },
    ] }],
  ])("rejects %s", (_name, malformed) => {
    expect(() => defineCreditProgramRevision({
      programRef: "credit-program:starter", revision: 1n, expectedVersion: 0n,
      canonicalDefinition: canonicalCreditProgramDefinitionFromBytes(
        encodeCreditProgramDefinition(malformed as CreditProgramDefinition)),
      publishedAt: "2026-08-01T00:00:00.000Z",
    })).toThrow(/CREDIT_PROGRAM_/u);
  });

  it("rejects a client-selected non-successor revision", () => {
    expect(() => defineCreditProgramRevision({
      programRef: "credit-program:starter", revision: 3n, expectedVersion: 1n,
      canonicalDefinition: canonicalCreditProgramDefinitionFromBytes(encodeCreditProgramDefinition(definition)),
      publishedAt: "2026-08-01T00:00:00.000Z",
    })).toThrow("CREDIT_PROGRAM_REVISION_SEQUENCE_INVALID");
  });

  it("publishes through one owner UoW with deployment and actor facts supplied by verified context", async () => {
    const publishRevision = vi.fn(async (_transaction, command, candidate) => ({
      kind: "published" as const, revision: candidate, recordedAt: candidate.publishedAt,
    }));
    const execute = vi.fn(async (_input, work) => work({ kind: "test-transaction" } as never));
    const service = new CreditProgramCatalogService({ unitOfWork: { execute } as never,
      repository: { publishRevision }, decodeDefinitionBytes: canonicalCreditProgramDefinitionFromBytes,
      clock: () => "2026-08-01T00:00:00.000Z" });
    const result = await service.publishRevision({
      commandId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "publish-starter-v1",
      requestDigest: "b".repeat(64), programRef: "credit-program:starter",
      revision: 1n, expectedVersion: 0n,
      definitionBytes: encodeCreditProgramDefinition(definition), reason: "publish starter policy",
    }, globalContext() as never);

    expect(result.kind).toBe("published");
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "credit.program.publish" }),
      expect.any(Function));
    expect(publishRevision).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      environment: "production", region: "us-east-1", actorSubjectId: "operator:1",
      expectedVersion: 0n,
    }), expect.objectContaining({ exposure: "inert" }));
  });

  it("uses PostgreSQL tzdata as the final authority before persisting a daily window", async () => {
    const candidate = defineCreditProgramRevision({
      programRef: "credit-program:starter", revision: 1n, expectedVersion: 0n,
      canonicalDefinition: canonicalCreditProgramDefinitionFromBytes(
        encodeCreditProgramDefinition(definition)),
      publishedAt: "2026-08-01T00:00:00.000Z",
    });
    const lease = issuePlatformTransaction({
      execute: async () => 1,
      query: async <Row extends Record<string, unknown>>(text: string) => {
        if (text.includes("FROM platform.command_receipt")) return [{
          commandId: "00000000-0000-4000-8000-000000000001",
          environment: "production", region: "us-east-1", callerIdentity: "admin-ui",
          operation: "credit.program.publish", idempotencyKey: "publish-starter-v1",
          requestDigest: "b".repeat(64), state: "pending", result: null, resultDigest: null,
          recordedAt: "2026-08-01T00:00:00.000Z",
        }] as unknown as Row[];
        if (text.includes("pg_timezone_names")) return [{ valid: false }] as unknown as Row[];
        throw new Error("CREDIT_PROGRAM_TEST_UNEXPECTED_QUERY");
      },
    });
    try {
      await expect(new PostgresCreditProgramCatalog().publishRevision(lease.transaction, {
        commandId: "00000000-0000-4000-8000-000000000001",
        environment: "production", region: "us-east-1", callerIdentity: "admin-ui",
        operation: "credit.program.publish", idempotencyKey: "publish-starter-v1",
        requestDigest: "b".repeat(64), expectedVersion: 0n,
        actorSubjectId: "operator:1", reason: "publish starter policy",
      }, candidate)).rejects.toThrow("CREDIT_PROGRAM_CALENDAR_ZONE_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a forged historical snapshot ref/digest pair before reading page membership", async () => {
    let pageRead = false;
    const host = { read: async <Result>(_permit: unknown,
      work: (transaction: never) => Promise<Result>): Promise<Result> => {
      const lease = issuePlatformTransaction({
        query: async <Row extends Record<string, unknown>>(text: string) => {
          if (text.includes("commerce_credit_program_catalog_snapshot WHERE")) {
            return [{ currentEpoch: "3", snapshotDigest: `sha256:${"3".repeat(64)}` }] as unknown as Row[];
          }
          if (text.includes("commerce_credit_program_catalog_snapshot_revision")) {
            return [{ epoch: "1", snapshotRef: "credit-program-snapshot:1",
              snapshotDigest: `sha256:${"1".repeat(64)}` }] as unknown as Row[];
          }
          pageRead = true; return [] as Row[];
        }, execute: async () => 0,
      });
      try { return await work(lease.transaction as never); } finally { revokePlatformTransaction(lease); }
    } };
    const reader = new PostgresCreditProgramCatalogReader(host);
    await expect(reader.list({ operation: "credit.program.read", environment: "production",
      region: "us-east-1", authorityBindingDigest: "a".repeat(64), scope: "global" }, {
      programRef: null, publishedAfter: null, publishedBefore: null, afterEpoch: 0n, limit: 50,
      snapshot: { epoch: 1n, ref: "credit-program-snapshot:1", digest: `sha256:${"f".repeat(64)}` },
    })).rejects.toThrow("CREDIT_PROGRAM_SNAPSHOT_INVALID");
    expect(pageRead).toBe(false);
  });
});

function scopePolicy() {
  return Object.freeze({ version: 1 as const, surfaceRefs: Object.freeze(["chat"]),
    capabilityKeys: Object.freeze(["chat.generate"]), agentRefs: Object.freeze([] as string[]),
    allowUnattributedAgent: true });
}

function globalContext() {
  return {
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin-ui" },
    actor: { kind: "operator", subjectId: "operator:1" },
    target: { siteId: null, purpose: "credit.program.publish",
      scopes: ["admin:global", "credit.program.publish"] },
    environment: "production", region: "us-east-1",
  };
}
