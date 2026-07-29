import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { SignedScopedSessionAuthorizationPublisher } from "../../src/modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import type { PostgresScopedAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { AuthorizationEventSigningPayloadSchema } from "../../src/interfaces/connect/generated-authorization-v2/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";

describe("v2 scoped authorization publisher", () => {
  it("signs the exact SubjectCurrent protobuf fact", async () => {
    let appended: Parameters<PostgresScopedAuthorizationFeedRepository["appendSubjectCurrent"]>[1] | undefined;
    const repository = {
      async reserveSubjectMutation() {
        return { siteRef: "site-1", streamSequence: 10n, aggregateSequence: 4n };
      },
      async appendSubjectCurrent(_transaction: unknown, event: NonNullable<typeof appended>) {
        appended = event;
      },
    } as unknown as PostgresScopedAuthorizationFeedRepository;
    const publisher = new SignedScopedSessionAuthorizationPublisher(repository, {
      keyRevision: "key-1",
      async sign() { return new Uint8Array(64).fill(1); },
    }, () => "018f1111-1111-7111-8111-111111111111");
    const transaction = issuePlatformTransaction({
      async query() { return []; }, async execute() { return 0; },
    }).transaction;
    const reservation = await publisher.reserveSubjectMutation(transaction, { siteRef: "site-1" });
    await publisher.publishSubjectCurrent(transaction, {
      reservation,
      current: {
        siteRef: "site-1", subjectRef: "subject-1", state: "active",
        subjectGeneration: "1", restrictionEpoch: "1",
        updatedAt: "2026-07-29T00:00:00.000Z", retainUntil: "2026-09-01T00:00:00.000Z",
      },
      correlationId: "correlation-1",
    });
    const payload = fromBinary(AuthorizationEventSigningPayloadSchema, appended!.signingPayload);
    expect(payload.event.case).toBe("subjectCurrentChanged");
  });

  it("signs the exact IdentitySessionCurrent protobuf fact", async () => {
    let appended: Parameters<PostgresScopedAuthorizationFeedRepository["appendIdentitySessionCurrent"]>[1] | undefined;
    const repository = {
      async reserveIdentitySessionMutation() {
        return { siteRef: "site-1", streamSequence: 11n, aggregateSequence: 5n };
      },
      async appendIdentitySessionCurrent(_transaction: unknown, event: NonNullable<typeof appended>) {
        appended = event;
      },
    } as unknown as PostgresScopedAuthorizationFeedRepository;
    const signer = {
      keyRevision: "key-1",
      async sign(payload: Uint8Array) {
        expect(payload.byteLength).toBeGreaterThan(32);
        return new Uint8Array(64).fill(1);
      },
    };
    const publisher = new SignedScopedSessionAuthorizationPublisher(repository, signer, () =>
      "018f1111-1111-7111-8111-111111111111");
    const transaction = issuePlatformTransaction({
      async query() { return []; },
      async execute() { return 0; },
    }).transaction;
    const reservation = await publisher.reserveIdentitySessionMutation(transaction, { siteRef: "site-1" });

    await publisher.publishIdentitySessionCurrent(transaction, {
      reservation,
      current: {
        siteRef: "site-1",
        subjectRef: "subject-1",
        identitySessionRef: "session-1",
        state: "revoked",
        identitySessionEpoch: "2",
        credentialEpoch: "3",
        expiresAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
        retainUntil: "2026-09-01T00:00:00.000Z",
      },
      correlationId: "correlation-1",
    });

    expect(appended?.payloadDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(appended?.signature).toHaveLength(64);
    const payload = fromBinary(AuthorizationEventSigningPayloadSchema, appended!.signingPayload);
    expect(payload.streamSequence).toBe(11n);
    expect(payload.aggregateSequence).toBe(5n);
    expect(payload.event.case).toBe("identitySessionCurrentChanged");
    if (payload.event.case !== "identitySessionCurrentChanged") throw new Error("wrong event");
    expect(payload.event.value.identitySessionRef).toBe("session-1");
    expect(payload.event.value.identitySessionEpoch).toBe(2n);
  });
});
