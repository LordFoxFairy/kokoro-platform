import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { createScopedSessionAuthorizationFeedService } from "../../src/interfaces/connect/scoped-session-authorization.js";
import {
  AuthorizationEventSigningPayloadSchema,
  AuthorizationSnapshotReason,
  PullAuthorizationEventsRequestSchema,
} from "../../src/interfaces/connect/generated-authorization-v2/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";
import type { PostgresScopedAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";

describe("scoped Session authorization provider", () => {
  it("requires snapshot recovery when the consumer cursor is ahead", async () => {
    const service = createService({
      readWindow: async () => ({ highWatermark: 4n, oldestAvailable: 1n, snapshotRequired: false, events: [] }),
    });
    const response = await service.pullAuthorizationEvents(
      create(PullAuthorizationEventsRequestSchema, { afterStreamSequence: 5n, limit: 10 }),
      { signal: new AbortController().signal } as never,
    );
    expect(response.outcome?.case).toBe("snapshotRequired");
    if (response.outcome?.case !== "snapshotRequired" || response.outcome.value === undefined) {
      throw new Error("expected snapshot");
    }
    expect(response.outcome.value.reason).toBe(AuthorizationSnapshotReason.SEQUENCE_GAP);
  });

  it("fails closed when the signed owner fact and envelope Site differ", async () => {
    const payload = create(AuthorizationEventSigningPayloadSchema, {
      eventId: "018f1111-1111-7111-8111-111111111111", streamSequence: 1n,
      siteRef: "site-1", aggregateSequence: 1n, occurredAt: { seconds: 1n, nanos: 0 },
      event: {
        case: "subjectCurrentChanged",
        value: {
          siteRef: "site-2", subjectRef: "subject-1", state: 1, subjectGeneration: 1n,
          restrictionEpoch: 1n, updatedAt: { seconds: 1n, nanos: 0 },
          retainUntil: { seconds: 301n, nanos: 0 },
        },
      },
    });
    const bytes = toBinary(AuthorizationEventSigningPayloadSchema, payload, { writeUnknownFields: false });
    const service = createService({
      readWindow: async () => ({
        highWatermark: 1n, oldestAvailable: 1n, snapshotRequired: false,
        events: [{
          reservation: { siteRef: "site-1", streamSequence: 1n, aggregateSequence: 1n },
          eventId: payload.eventId, occurredAt: "1970-01-01T00:00:01.000Z",
          signingPayload: bytes, payloadDigest: createHash("sha256").update(bytes).digest("hex"), signingKeyRevision: "key-1",
          signature: new Uint8Array(64).fill(1), correlationId: "correlation-1",
        }],
      }),
    });
    await expect(service.pullAuthorizationEvents(
      create(PullAuthorizationEventsRequestSchema, { afterStreamSequence: 0n, limit: 10 }),
      { signal: new AbortController().signal } as never,
    )).rejects.toMatchObject({ code: 15 });
  });
});

function createService(overrides: Partial<PostgresScopedAuthorizationFeedRepository>) {
  const repository = {
    readWindow: async () => ({ highWatermark: 0n, oldestAvailable: 1n, snapshotRequired: false, events: [] }),
    createSnapshot: async () => ({ highWatermark: 0n, recordCount: 0 }),
    readSnapshotPage: async () => null,
    ...overrides,
  } as unknown as PostgresScopedAuthorizationFeedRepository;
  return createScopedSessionAuthorizationFeedService({
    database: { internalTransaction: async (_operation, work) => work({} as never) },
    repository,
    verificationKeySet: {
      keySetRevision: "a".repeat(64),
      verificationKeys: () => [{
        purpose: "event_signing", keyRevision: "event-1", current: true,
        canonicalPublicJwkJson: "{\"kty\":\"RSA\"}",
        notBefore: "2026-07-28T00:00:00.000Z", notAfter: "2026-07-30T00:00:00.000Z",
      }, {
        purpose: "session_access_grant", keyRevision: "grant-1", current: true,
        canonicalPublicJwkJson: "{\"kty\":\"RSA\"}",
        notBefore: "2026-07-28T00:00:00.000Z", notAfter: "2026-07-30T00:00:00.000Z",
      }],
    },
    cursorSecret: new Uint8Array(32).fill(7),
    clock: () => new Date("2026-07-29T00:00:00.000Z"),
  });
}
