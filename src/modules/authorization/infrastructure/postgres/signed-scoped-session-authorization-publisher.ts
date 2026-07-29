import { createHash, randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type {
  IdentitySessionAuthorizationState,
  IdentitySessionCurrentFact,
  ScopedSubjectAuthorizationMutationPort,
  ScopedSessionAuthorizationMutationPort,
  SubjectCurrentFact,
} from "../../application/contracts/scoped-session-authorization-port.js";
import type { SessionAuthorizationEventSigner } from "../../application/contracts/session-authorization-ports.js";
import {
  AuthorizationEventSigningPayloadSchema,
  type AuthorizationEventSigningPayload,
  AuthorizationIdentitySessionState,
  AuthorizationSubjectState,
  IdentitySessionCurrentSchema,
  SubjectCurrentSchema,
} from "../../../../interfaces/connect/generated-authorization-v2/kokoro/platform/authorization/v2/scoped_session_authorization_pb.js";
import { PostgresScopedAuthorizationFeedRepository } from "./scoped-authorization-feed-repository.js";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

export class SignedScopedSessionAuthorizationPublisher implements
  ScopedSessionAuthorizationMutationPort, ScopedSubjectAuthorizationMutationPort {
  constructor(
    private readonly repository: PostgresScopedAuthorizationFeedRepository,
    private readonly signer: SessionAuthorizationEventSigner,
    private readonly eventId: () => string = randomUUID,
  ) {}

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
