import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { SignedScopedSessionAuthorizationPublisher } from "../../src/modules/authorization/infrastructure/postgres/signed-scoped-session-authorization-publisher.js";
import type { PostgresScopedAuthorizationFeedRepository } from "../../src/modules/authorization/infrastructure/postgres/scoped-authorization-feed-repository.js";
import { AuthorizationEventSigningPayloadSchema } from "../../src/generated/proto/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";

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

  it("publishes SiteCurrent, ProjectMembershipCurrent and GrantDelivered on the same stream", async () => {
    const payloads: Uint8Array[] = [];
    let grantReservations = 0;
    const repository = {
      async reserveSiteMutation() {
        return { siteRef: "site-1", streamSequence: 12n, aggregateSequence: 6n };
      },
      async reserveProjectMembershipMutation() {
        return { siteRef: "site-1", streamSequence: 13n, aggregateSequence: 7n };
      },
      async reserveGrantDelivery() {
        grantReservations += 1;
        return { siteRef: "site-1", streamSequence: 14n, aggregateSequence: 8n };
      },
      async appendSiteCurrent(_transaction: unknown, event: { signingPayload: Uint8Array }) {
        payloads.push(event.signingPayload);
      },
      async appendProjectMembershipCurrent(_transaction: unknown, event: { signingPayload: Uint8Array }) {
        payloads.push(event.signingPayload);
      },
      async appendGrantDelivered(_transaction: unknown, event: { signingPayload: Uint8Array }) {
        payloads.push(event.signingPayload);
      },
    } as unknown as PostgresScopedAuthorizationFeedRepository;
    const publisher = new SignedScopedSessionAuthorizationPublisher(repository, {
      keyRevision: "key-1",
      async sign() { return new Uint8Array(64).fill(1); },
    }, () => "018f1111-1111-7111-8111-111111111111");
    const transaction = issuePlatformTransaction({
      async query() { return []; }, async execute() { return 0; },
    }).transaction;

    const siteReservation = await publisher.reserveSiteMutation(transaction, { siteRef: "site-1" });
    await publisher.publishSiteCurrent(transaction, {
      reservation: siteReservation,
      current: {
        siteRef: "site-1", state: "active", siteSecurityEpoch: "2", policyEpoch: "3",
        revocationEpoch: "4", updatedAt: "2026-07-29T00:00:00.000Z",
        retainUntil: "2026-07-29T00:05:00.000Z",
      },
      correlationId: "correlation-1",
    });
    const membershipReservation = await publisher.reserveProjectMembershipMutation(
      transaction,
      { siteRef: "site-1" },
    );
    await publisher.publishProjectMembershipCurrent(transaction, {
      reservation: membershipReservation,
      current: {
        siteRef: "site-1", subjectRef: "subject-1", projectRef: "project-1", state: "active",
        membershipEpoch: "5", authorizationEpoch: "6", updatedAt: "2026-07-29T00:00:01.000Z",
        retainUntil: "2026-07-29T00:05:01.000Z",
      },
      correlationId: "correlation-1",
    });
    const grantReservation = await publisher.reserveGrantDelivery(transaction, { siteRef: "site-1" });
    await publisher.publishGrantDelivered(transaction, {
      reservation: grantReservation,
      claims: {
        grantRef: "grant-1",
        binding: {
          productContextRef: "context-1", siteProjectBindingRef: "binding-1",
          deploymentRef: "deployment-1", siteRef: "site-1", siteReleaseRef: "release-1",
          webArtifactDigest: "a".repeat(64), runtimeEnvironment: "production", region: "us-east-1",
          sessionContractRevision: "v3", projectRef: "project-1", subjectRef: "subject-1",
          subjectGeneration: "2", identitySessionRef: "session-1", issuer: "issuer-1",
          keyRevision: "grant-key-1", notBefore: "2026-07-29T00:00:00.000Z",
          siteSecurityEpoch: "2", identitySessionEpoch: "3", membershipEpoch: "5",
          authorizationEpoch: "6", restrictionEpoch: "7", credentialEpoch: "8",
          policyEpoch: "3", revocationEpoch: "4", authorizationStreamSequence: "14", resource: { kind: "project" },
          issuedAt: "2026-07-29T00:00:01.000Z", expiresAt: "2026-07-29T00:05:01.000Z",
        },
        authorization: { purpose: "read", audience: "session.read" },
      },
      claimsDigest: "b".repeat(64),
      changedAt: "2026-07-29T00:00:01.000Z",
      correlationId: "correlation-1",
    });

    expect(payloads.map((bytes) => fromBinary(AuthorizationEventSigningPayloadSchema, bytes).event.case))
      .toEqual(["siteCurrentChanged", "projectMembershipCurrentChanged", "grantDelivered"]);
    expect(payloads.map((bytes) => fromBinary(AuthorizationEventSigningPayloadSchema, bytes).streamSequence))
      .toEqual([12n, 13n, 14n]);
    expect(grantReservations).toBe(1);
  });
});
