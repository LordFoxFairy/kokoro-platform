import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { createSessionAuthorizationFeedService } from "../../src/interfaces/connect/session-authorization.js";
import {
  AuthorizationVerificationKeyPurpose,
  AuthorizationSnapshotReason,
  AuthorizationSnapshotRecordSchema,
  GetAuthorizationSnapshotPageRequestSchema,
  GetAuthorizationVerificationKeysRequestSchema,
  PullAuthorizationEventsRequestSchema,
} from "../../src/interfaces/connect/generated-authorization/kokoro/platform/authorization/v1/session_authorization_pb.js";
import { createSessionAuthorizationVerificationKeySet } from "../../src/modules/authorization/infrastructure/jose/session-authorization-verification-key-set.js";
import type { PostgresAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/authorization-feed-repository.js";

describe("Session authorization feed security", () => {
  it("fails to snapshot when a pull cursor is ahead of the transactional high-watermark", async () => {
    const service = createService({
      readWindow: async () => ({
        highWatermark: 4n,
        oldestAvailable: 1n,
        snapshotRequired: false,
        events: [],
      }),
    });
    const response = await service.pullAuthorizationEvents(
      create(PullAuthorizationEventsRequestSchema, { afterStreamSequence: 5n, limit: 10 }),
      { signal: new AbortController().signal } as never,
    );
    const outcome = response.outcome;
    expect(outcome?.case).toBe("snapshotRequired");
    if (outcome?.case !== "snapshotRequired" || outcome.value === undefined) throw new Error("expected snapshot");
    expect(outcome.value.reason).toBe(AuthorizationSnapshotReason.SEQUENCE_GAP);
    expect(outcome.value.highWatermarkStreamSequence).toBe(4n);
  });

  it("binds an opaque snapshot cursor to its random snapshot reference and MAC", async () => {
    let snapshotRef = "";
    const record = create(AuthorizationSnapshotRecordSchema, {});
    const service = createService({
      createSnapshot: async (_transaction, input) => {
        snapshotRef = input.snapshotRef;
        return { highWatermark: 0n, recordCount: 2 };
      },
      readSnapshotPage: async () => ({
        highWatermark: 0n,
        keySetRevision: "a".repeat(64),
        frozenAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2026-07-29T00:05:00.000Z",
        records: [
          { ordinal: 0n, record },
          { ordinal: 1n, record },
        ],
      }),
    }, () => new Date("2026-07-29T00:00:00.000Z"));
    const first = await service.getAuthorizationSnapshotPage(
      create(GetAuthorizationSnapshotPageRequestSchema, { limit: 1 }),
      {} as never,
    );
    expect(snapshotRef).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.page?.keySetRevision).toBe("a".repeat(64));
    const cursor = first.page?.nextPageCursor;
    expect(cursor).toBeTypeOf("string");
    await expect(service.getAuthorizationSnapshotPage(
      create(GetAuthorizationSnapshotPageRequestSchema, {
        snapshotRef,
        pageCursor: `${cursor!.slice(0, -1)}x`,
        limit: 1,
      }),
      {} as never,
    )).rejects.toMatchObject({ code: 3 });
  });

  it("derives an order-independent purpose-scoped public key-set revision", async () => {
    const event = key("shared-revision", "event_signing", true);
    const grant = key("shared-revision", "session_access_grant", true);
    const previous = key("grant-previous", "session_access_grant", false);
    const forward = await createSessionAuthorizationVerificationKeySet([event, grant, previous]);
    const reverse = await createSessionAuthorizationVerificationKeySet([previous, grant, event]);
    expect(forward.keySetRevision).toBe(reverse.keySetRevision);
    expect(forward.verificationKeys().map((item) => `${item.purpose}:${item.keyRevision}`)).toEqual([
      "event_signing:shared-revision",
      "session_access_grant:grant-previous",
      "session_access_grant:shared-revision",
    ]);
    await expect(createSessionAuthorizationVerificationKeySet([
      event,
      { ...event, current: false },
      grant,
    ])).rejects.toThrow("AUTHORIZATION_VERIFICATION_KEY_INVALID");
  });

  it("publishes both verification purposes without exposing signing material", async () => {
    const response = await createService({}).getAuthorizationVerificationKeys(
      create(GetAuthorizationVerificationKeysRequestSchema, {}),
      {} as never,
    );
    const outcome = response.outcome;
    expect(outcome?.case).toBe("keySet");
    if (outcome?.case !== "keySet" || outcome.value === undefined) throw new Error("expected key set");
    const keys = outcome.value.keys ?? [];
    expect(keys.map((key) => key.purpose)).toEqual([
      AuthorizationVerificationKeyPurpose.EVENT_SIGNING,
      AuthorizationVerificationKeyPurpose.SESSION_ACCESS_GRANT,
    ]);
    expect(keys.every((key) => !("privateKeyPem" in key))).toBe(true);
  });

  it("keeps feed and snapshot rows immutable under least-privilege grants", async () => {
    const migration = await readFile("prisma/migrations/20260729_session_authorization_feed/migration.sql", "utf8");
    expect(migration).toContain("GRANT SELECT,UPDATE ON TABLE platform.authorization_stream_state TO platform_api");
    expect(migration).toContain("GRANT INSERT ON TABLE platform.authorization_event_log TO platform_api");
    expect(migration).toContain("TO platform_authorization");
    expect(migration).not.toContain("GRANT SELECT,INSERT,UPDATE ON TABLE");
    expect(migration).toContain("CREATE TRIGGER authorization_event_immutable");
    expect(migration).toContain("CREATE TRIGGER authorization_snapshot_immutable");
    expect(migration).toContain("CREATE TRIGGER authorization_snapshot_record_immutable");
  });
});

function createService(
  repositoryOverrides: Partial<PostgresAuthorizationFeedRepository>,
  clock: () => Date = () => new Date("2026-07-29T00:00:00.000Z"),
) {
  const repository = {
    readWindow: async () => ({ highWatermark: 0n, oldestAvailable: 1n, snapshotRequired: false, events: [] }),
    createSnapshot: async () => ({ highWatermark: 0n, recordCount: 0 }),
    readSnapshotPage: async () => null,
    ...repositoryOverrides,
  } as unknown as PostgresAuthorizationFeedRepository;
  return createSessionAuthorizationFeedService({
    database: {
      internalTransaction: async (_operation, work) => work({} as never),
    },
    repository,
    verificationKeySet: {
      keySetRevision: "a".repeat(64),
      verificationKeys: () => [{
        purpose: "event_signing" as const,
        keyRevision: "key-a",
        current: true,
        canonicalPublicJwkJson: JSON.stringify({ alg: "RS256", kid: "key-a", kty: "RSA", n: "n", e: "AQAB" }),
        notBefore: "2026-07-28T00:00:00.000Z",
        notAfter: "2026-07-30T00:00:00.000Z",
      }, {
        purpose: "session_access_grant" as const,
        keyRevision: "grant-a",
        current: true,
        canonicalPublicJwkJson: JSON.stringify({ alg: "RS256", kid: "grant-a", kty: "RSA", n: "n", e: "AQAB" }),
        notBefore: "2026-07-28T00:00:00.000Z",
        notAfter: "2026-07-30T00:00:00.000Z",
      }],
    },
    cursorSecret: new Uint8Array(32).fill(7),
    clock,
  });
}

function key(
  keyRevision: string,
  purpose: "event_signing" | "session_access_grant",
  current: boolean,
) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Object.freeze({
    purpose,
    keyRevision,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    current,
    notBefore: "2026-01-01T00:00:00.000Z",
    notAfter: "2027-01-01T00:00:00.000Z",
  });
}
