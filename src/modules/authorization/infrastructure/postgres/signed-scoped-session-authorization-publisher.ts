import { createHash, randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type {
  IdentitySessionAuthorizationState,
  IdentitySessionCurrentFact,
  ProjectMembershipCurrentFact,
  ScopedAuthorizationBatchReservationPort,
  ScopedProjectMembershipAuthorizationMutationPort,
  ScopedSiteAuthorizationMutationPort,
  ScopedSubjectAuthorizationMutationPort,
  ScopedSessionAuthorizationMutationPort,
  SiteCurrentFact,
  SubjectCurrentFact,
} from "../../application/contracts/scoped-session-authorization-port.js";
import type { SessionAuthorizationEventSigner } from "../../application/contracts/session-authorization-ports.js";
import {
  AuthorizationEventSigningPayloadSchema,
  AuthorizationEpochVectorSchema,
  type AuthorizationEventSigningPayload,
  AuthorizationIdentitySessionState,
  AuthorizationProjectMembershipState,
  AuthorizationSiteState,
  AuthorizationSubjectState,
  DeliveredGrantFactSchema,
  IdentitySessionCurrentSchema,
  ProjectMembershipCurrentSchema,
  SiteCurrentSchema,
  SubjectCurrentSchema,
} from "../../../../generated/proto/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";
import { PostgresScopedAuthorizationFeedRepository } from "./scoped-authorization-feed-repository.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export class SignedScopedSessionAuthorizationPublisher implements
  ScopedSessionAuthorizationMutationPort, ScopedSubjectAuthorizationMutationPort,
  ScopedSiteAuthorizationMutationPort, ScopedProjectMembershipAuthorizationMutationPort,
  ScopedAuthorizationBatchReservationPort {
  constructor(
    private readonly repository: PostgresScopedAuthorizationFeedRepository,
    private readonly signer: SessionAuthorizationEventSigner,
    private readonly eventId: () => string = randomUUID,
  ) {}

  reserveOwnerMutations(
    transaction: Parameters<ScopedAuthorizationBatchReservationPort["reserveOwnerMutations"]>[0],
    input: Parameters<ScopedAuthorizationBatchReservationPort["reserveOwnerMutations"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveOwnerMutations(transaction, input.siteRef, input.count);
  }

  async reserveSiteMutation(
    transaction: Parameters<ScopedSiteAuthorizationMutationPort["reserveSiteMutation"]>[0],
    input: Parameters<ScopedSiteAuthorizationMutationPort["reserveSiteMutation"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveSiteMutation(transaction, input.siteRef);
  }

  async publishSiteCurrent(
    transaction: Parameters<ScopedSiteAuthorizationMutationPort["publishSiteCurrent"]>[0],
    input: Parameters<ScopedSiteAuthorizationMutationPort["publishSiteCurrent"]>[1],
  ): Promise<void> {
    assertSiteCurrent(input.current);
    const payload = this.basePayload(input.reservation, input.current, {
      case: "siteCurrentChanged" as const,
      value: create(SiteCurrentSchema, {
        siteRef: input.current.siteRef,
        state: siteState(input.current.state),
        siteSecurityEpoch: epoch(input.current.siteSecurityEpoch),
        policyEpoch: epoch(input.current.policyEpoch),
        siteRevocationEpoch: epoch(input.current.revocationEpoch),
        updatedAt: timestampFromDate(new Date(input.current.updatedAt)),
        retainUntil: timestampFromDate(new Date(input.current.retainUntil)),
      }),
    });
    await this.append(transaction, input, payload, (event) =>
      this.repository.appendSiteCurrent(transaction, event));
  }

  async reserveSubjectMutation(
    transaction: Parameters<ScopedSubjectAuthorizationMutationPort["reserveSubjectMutation"]>[0],
    input: Parameters<ScopedSubjectAuthorizationMutationPort["reserveSubjectMutation"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveSubjectMutation(transaction, input.siteRef);
  }

  async publishSubjectCurrent(
    transaction: Parameters<ScopedSubjectAuthorizationMutationPort["publishSubjectCurrent"]>[0],
    input: Parameters<ScopedSubjectAuthorizationMutationPort["publishSubjectCurrent"]>[1],
  ): Promise<void> {
    assertSubjectCurrent(input.current);
    assertReference(input.correlationId, 256);
    if (
      input.reservation.siteRef !== input.current.siteRef ||
      input.reservation.streamSequence < 1n ||
      input.reservation.aggregateSequence < 1n
    ) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_INVALID");
    }
    const occurredAt = new Date(input.current.updatedAt);
    const payload = create(AuthorizationEventSigningPayloadSchema, {
      eventId: this.eventId(), streamSequence: input.reservation.streamSequence,
      siteRef: input.current.siteRef, aggregateSequence: input.reservation.aggregateSequence,
      occurredAt: timestampFromDate(occurredAt),
      event: {
        case: "subjectCurrentChanged",
        value: create(SubjectCurrentSchema, {
          siteRef: input.current.siteRef,
          subjectRef: input.current.subjectRef,
          state: subjectState(input.current.state),
          subjectGeneration: epoch(input.current.subjectGeneration),
          restrictionEpoch: epoch(input.current.restrictionEpoch),
          updatedAt: timestampFromDate(occurredAt),
          retainUntil: timestampFromDate(new Date(input.current.retainUntil)),
        }),
      },
    });
    const signed = await this.sign(payload);
    await this.repository.appendSubjectCurrent(transaction, {
      reservation: input.reservation,
      eventId: payload.eventId,
      occurredAt: occurredAt.toISOString(),
      ...signed,
      correlationId: input.correlationId,
    });
  }

  async reserveIdentitySessionMutation(
    transaction: Parameters<ScopedSessionAuthorizationMutationPort["reserveIdentitySessionMutation"]>[0],
    input: Parameters<ScopedSessionAuthorizationMutationPort["reserveIdentitySessionMutation"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveIdentitySessionMutation(transaction, input.siteRef);
  }

  async reserveProjectMembershipMutation(
    transaction: Parameters<ScopedProjectMembershipAuthorizationMutationPort["reserveProjectMembershipMutation"]>[0],
    input: Parameters<ScopedProjectMembershipAuthorizationMutationPort["reserveProjectMembershipMutation"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveProjectMembershipMutation(transaction, input.siteRef);
  }

  async publishProjectMembershipCurrent(
    transaction: Parameters<ScopedProjectMembershipAuthorizationMutationPort["publishProjectMembershipCurrent"]>[0],
    input: Parameters<ScopedProjectMembershipAuthorizationMutationPort["publishProjectMembershipCurrent"]>[1],
  ): Promise<void> {
    assertMembershipCurrent(input.current);
    const payload = this.basePayload(input.reservation, input.current, {
      case: "projectMembershipCurrentChanged" as const,
      value: create(ProjectMembershipCurrentSchema, {
        siteRef: input.current.siteRef,
        subjectRef: input.current.subjectRef,
        projectRef: input.current.projectRef,
        state: membershipState(input.current.state),
        membershipEpoch: epoch(input.current.membershipEpoch),
        authorizationEpoch: epoch(input.current.authorizationEpoch),
        updatedAt: timestampFromDate(new Date(input.current.updatedAt)),
        retainUntil: timestampFromDate(new Date(input.current.retainUntil)),
      }),
    });
    await this.append(transaction, input, payload, (event) =>
      this.repository.appendProjectMembershipCurrent(transaction, event));
  }

  async publishGrantDelivered(
    transaction: Parameters<import("../../application/contracts/session-authorization-ports.js").SessionGrantDeliveryPublisher["publishGrantDelivered"]>[0],
    input: Parameters<import("../../application/contracts/session-authorization-ports.js").SessionGrantDeliveryPublisher["publishGrantDelivered"]>[1],
  ): Promise<void> {
    const binding = input.claims.binding;
    assertReference(input.correlationId, 256);
    if (!/^[0-9a-f]{64}$/u.test(input.claimsDigest)) throw new Error("SCOPED_AUTHORIZATION_DIGEST_INVALID");
    const reservation = input.reservation;
    if (binding.authorizationStreamSequence !== reservation.streamSequence.toString()) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_INVALID");
    }
    const changedAt = instant(input.changedAt);
    const payload = this.basePayload(reservation, { siteRef: binding.siteRef, updatedAt: changedAt }, {
      case: "grantDelivered" as const,
      value: create(DeliveredGrantFactSchema, {
        grantRef: input.claims.grantRef, siteRef: binding.siteRef, subjectRef: binding.subjectRef,
        identitySessionRef: binding.identitySessionRef, projectRef: binding.projectRef,
        purpose: input.claims.authorization.purpose, audience: input.claims.authorization.audience,
        claimsDigest: input.claimsDigest, grantKeyRevision: binding.keyRevision,
        epochs: create(AuthorizationEpochVectorSchema, {
          siteSecurityEpoch: epoch(binding.siteSecurityEpoch),
          subjectGeneration: epoch(binding.subjectGeneration),
          identitySessionEpoch: epoch(binding.identitySessionEpoch),
          membershipEpoch: epoch(binding.membershipEpoch),
          authorizationEpoch: epoch(binding.authorizationEpoch),
          restrictionEpoch: epoch(binding.restrictionEpoch),
          credentialEpoch: epoch(binding.credentialEpoch),
          policyEpoch: epoch(binding.policyEpoch),
          siteRevocationEpoch: epoch(binding.revocationEpoch),
        }),
        expiresAt: timestampFromDate(new Date(binding.expiresAt)),
      }),
    });
    await this.append(transaction, { reservation, current: { siteRef: binding.siteRef, updatedAt: changedAt },
      correlationId: input.correlationId }, payload, (event) =>
      this.repository.appendGrantDelivered(transaction, event));
  }

  async reserveGrantDelivery(
    transaction: Parameters<import("../../application/contracts/session-authorization-ports.js").SessionGrantDeliveryPublisher["reserveGrantDelivery"]>[0],
    input: Parameters<import("../../application/contracts/session-authorization-ports.js").SessionGrantDeliveryPublisher["reserveGrantDelivery"]>[1],
  ) {
    assertReference(input.siteRef, 128);
    return this.repository.reserveGrantDelivery(transaction, input.siteRef);
  }

  private basePayload(
    reservation: import("../../application/contracts/scoped-session-authorization-port.js").ScopedAuthorizationReservation,
    current: Readonly<{ siteRef: string; updatedAt: string }>,
    event: AuthorizationEventSigningPayload["event"],
  ): AuthorizationEventSigningPayload {
    if (reservation.siteRef !== current.siteRef || reservation.streamSequence < 1n ||
        reservation.aggregateSequence < 1n) throw new Error("SCOPED_AUTHORIZATION_RESERVATION_INVALID");
    return create(AuthorizationEventSigningPayloadSchema, {
      eventId: this.eventId(), streamSequence: reservation.streamSequence, siteRef: current.siteRef,
      aggregateSequence: reservation.aggregateSequence,
      occurredAt: timestampFromDate(new Date(instant(current.updatedAt))), event,
    });
  }

  private async append(
    _transaction: Parameters<ScopedSiteAuthorizationMutationPort["publishSiteCurrent"]>[0],
    input: Readonly<{ reservation: import("../../application/contracts/scoped-session-authorization-port.js").ScopedAuthorizationReservation; current: Readonly<{ siteRef: string; updatedAt: string }>; correlationId: string }>,
    payload: AuthorizationEventSigningPayload,
    store: (event: import("./scoped-authorization-feed-repository.js").StoredScopedIdentitySessionEvent) => Promise<void>,
  ): Promise<void> {
    assertReference(input.correlationId, 256);
    const signed = await this.sign(payload);
    await store({ reservation: input.reservation, eventId: payload.eventId,
      occurredAt: instant(input.current.updatedAt), ...signed, correlationId: input.correlationId });
  }

  async publishIdentitySessionCurrent(
    transaction: Parameters<ScopedSessionAuthorizationMutationPort["publishIdentitySessionCurrent"]>[0],
    input: Parameters<ScopedSessionAuthorizationMutationPort["publishIdentitySessionCurrent"]>[1],
  ): Promise<void> {
    assertCurrent(input.current);
    assertReference(input.correlationId, 256);
    if (
      input.reservation.siteRef !== input.current.siteRef ||
      input.reservation.streamSequence < 1n ||
      input.reservation.aggregateSequence < 1n
    ) {
      throw new Error("SCOPED_AUTHORIZATION_RESERVATION_INVALID");
    }
    const occurredAt = new Date(input.current.updatedAt);
    const payload = create(AuthorizationEventSigningPayloadSchema, {
      eventId: this.eventId(),
      streamSequence: input.reservation.streamSequence,
      siteRef: input.current.siteRef,
      aggregateSequence: input.reservation.aggregateSequence,
      occurredAt: timestampFromDate(occurredAt),
      event: {
        case: "identitySessionCurrentChanged",
        value: create(IdentitySessionCurrentSchema, {
          siteRef: input.current.siteRef,
          subjectRef: input.current.subjectRef,
          identitySessionRef: input.current.identitySessionRef,
          state: state(input.current.state),
          identitySessionEpoch: epoch(input.current.identitySessionEpoch),
          credentialEpoch: epoch(input.current.credentialEpoch),
          expiresAt: timestampFromDate(new Date(input.current.expiresAt)),
          updatedAt: timestampFromDate(occurredAt),
          retainUntil: timestampFromDate(new Date(input.current.retainUntil)),
        }),
      },
    });
    const signed = await this.sign(payload);
    await this.repository.appendIdentitySessionCurrent(transaction, {
      reservation: input.reservation,
      eventId: payload.eventId,
      occurredAt: occurredAt.toISOString(),
      ...signed,
      correlationId: input.correlationId,
    });
  }

  private async sign(payload: AuthorizationEventSigningPayload) {
    const signingPayload = toBinary(AuthorizationEventSigningPayloadSchema, payload, { writeUnknownFields: false });
    const payloadDigest = createHash("sha256").update(signingPayload).digest("hex");
    const signature = await this.signer.sign(signingPayload);
    return Object.freeze({ signingPayload, payloadDigest, signingKeyRevision: this.signer.keyRevision, signature });
  }
}

function assertCurrent(current: IdentitySessionCurrentFact): void {
  assertReference(current.siteRef, 128);
  assertReference(current.subjectRef, 256);
  assertReference(current.identitySessionRef, 256);
  const updatedAt = Date.parse(current.updatedAt);
  const expiresAt = Date.parse(current.expiresAt);
  const retainUntil = Date.parse(current.retainUntil);
  if (
    !Number.isFinite(updatedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(retainUntil) ||
    expiresAt <= updatedAt ||
    retainUntil < expiresAt
  ) {
    throw new Error("SCOPED_AUTHORIZATION_CURRENT_INVALID");
  }
  epoch(current.identitySessionEpoch);
  epoch(current.credentialEpoch);
}

function assertSubjectCurrent(current: SubjectCurrentFact): void {
  assertReference(current.siteRef, 128);
  assertReference(current.subjectRef, 256);
  const updatedAt = Date.parse(current.updatedAt);
  const retainUntil = Date.parse(current.retainUntil);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(retainUntil) || retainUntil < updatedAt + 300_000) {
    throw new Error("SCOPED_AUTHORIZATION_CURRENT_INVALID");
  }
  epoch(current.subjectGeneration);
  epoch(current.restrictionEpoch);
}

function assertSiteCurrent(current: SiteCurrentFact): void {
  assertReference(current.siteRef, 128);
  assertRetainedCurrent(current.updatedAt, current.retainUntil);
  epoch(current.siteSecurityEpoch);
  epoch(current.policyEpoch);
  epoch(current.revocationEpoch);
}

function assertMembershipCurrent(current: ProjectMembershipCurrentFact): void {
  assertReference(current.siteRef, 128);
  assertReference(current.subjectRef, 256);
  assertReference(current.projectRef, 256);
  assertRetainedCurrent(current.updatedAt, current.retainUntil);
  epoch(current.membershipEpoch);
  epoch(current.authorizationEpoch);
}

function assertRetainedCurrent(updatedAtValue: string, retainUntilValue: string): void {
  const updatedAt = Date.parse(updatedAtValue);
  const retainUntil = Date.parse(retainUntilValue);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(retainUntil) || retainUntil < updatedAt + 300_000) {
    throw new Error("SCOPED_AUTHORIZATION_CURRENT_INVALID");
  }
}

function assertReference(value: string, maximum: number): void {
  if (
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
  ) {
    throw new Error("SCOPED_AUTHORIZATION_REFERENCE_INVALID");
  }
}

function epoch(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("SCOPED_AUTHORIZATION_EPOCH_INVALID");
  const parsed = BigInt(value);
  if (parsed > MAX_POSTGRES_BIGINT) throw new Error("SCOPED_AUTHORIZATION_EPOCH_INVALID");
  return parsed;
}

function state(value: IdentitySessionAuthorizationState): AuthorizationIdentitySessionState {
  return {
    active: AuthorizationIdentitySessionState.ACTIVE,
    revoked: AuthorizationIdentitySessionState.REVOKED,
    expired: AuthorizationIdentitySessionState.EXPIRED,
    removed: AuthorizationIdentitySessionState.REMOVED,
  }[value];
}

function subjectState(value: SubjectCurrentFact["state"]): AuthorizationSubjectState {
  return {
    active: AuthorizationSubjectState.ACTIVE,
    disabled: AuthorizationSubjectState.DISABLED,
    removed: AuthorizationSubjectState.REMOVED,
  }[value];
}

function siteState(value: SiteCurrentFact["state"]): AuthorizationSiteState {
  return {
    active: AuthorizationSiteState.ACTIVE,
    suspended: AuthorizationSiteState.SUSPENDED,
    decommissioning: AuthorizationSiteState.DECOMMISSIONING,
    decommissioned: AuthorizationSiteState.DECOMMISSIONED,
  }[value];
}

function membershipState(value: ProjectMembershipCurrentFact["state"]): AuthorizationProjectMembershipState {
  return {
    active: AuthorizationProjectMembershipState.ACTIVE,
    revoked: AuthorizationProjectMembershipState.REVOKED,
    removed: AuthorizationProjectMembershipState.REMOVED,
  }[value];
}

function instant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("SCOPED_AUTHORIZATION_CURRENT_INVALID");
  return new Date(milliseconds).toISOString();
}
