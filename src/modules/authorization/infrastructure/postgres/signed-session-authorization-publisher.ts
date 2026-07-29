import { createHash, randomUUID } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  AuthorizationEpochVectorSchema,
  AuthorizationEventSigningPayloadSchema,
  DeliveredGrantFactSchema,
  RevocationEpochChangedSchema,
  type AuthorizationEventSigningPayload,
} from "../../../../interfaces/connect/generated-authorization/kokoro/platform/authorization/v1/session_authorization_pb.js";
import type {
  SessionAuthorizationEventSigner,
  SessionAuthorizationPublisher,
} from "../../application/contracts/session-authorization-ports.js";
import { PostgresAuthorizationFeedRepository } from "./authorization-feed-repository.js";

export class SignedSessionAuthorizationPublisher implements SessionAuthorizationPublisher {
  constructor(
    private readonly repository: PostgresAuthorizationFeedRepository,
    private readonly signer: SessionAuthorizationEventSigner,
    private readonly eventId: () => string = randomUUID,
  ) {}

  async publishGrantDelivered(
    transaction: Parameters<SessionAuthorizationPublisher["publishGrantDelivered"]>[0],
    input: Parameters<SessionAuthorizationPublisher["publishGrantDelivered"]>[1],
  ): Promise<void> {
    const binding = input.claims.binding;
    const sequence = await this.repository.reserveSequence(transaction, binding.siteRef);
    const payload = create(AuthorizationEventSigningPayloadSchema, {
      eventId: this.eventId(),
      streamSequence: sequence.streamSequence,
      siteRef: binding.siteRef,
      aggregateSequence: sequence.aggregateSequence,
      occurredAt: timestampFromDate(new Date(input.changedAt)),
      event: {
        case: "grantDelivered",
        value: create(DeliveredGrantFactSchema, {
          grantRef: input.claims.grantRef,
          siteRef: binding.siteRef,
          subjectRef: binding.subjectRef,
          identitySessionRef: binding.identitySessionRef,
          projectRef: binding.projectRef,
          purpose: input.claims.authorization.purpose,
          audience: input.claims.authorization.audience,
          claimsDigest: input.claimsDigest,
          grantKeyRevision: binding.keyRevision,
          epochs: create(AuthorizationEpochVectorSchema, {
            siteSecurityEpoch: BigInt(binding.siteSecurityEpoch),
            subjectGeneration: BigInt(binding.subjectGeneration),
            identitySessionEpoch: BigInt(binding.identitySessionEpoch),
            membershipEpoch: BigInt(binding.membershipEpoch),
            authorizationEpoch: BigInt(binding.authorizationEpoch),
            restrictionEpoch: BigInt(binding.restrictionEpoch),
            credentialEpoch: BigInt(binding.credentialEpoch),
            policyEpoch: BigInt(binding.policyEpoch),
            revocationEpoch: BigInt(binding.revocationEpoch),
          }),
          expiresAt: timestampFromDate(new Date(binding.expiresAt)),
        }),
      },
    });
    await this.append(transaction, payload, "grant_delivered", input.correlationId);
  }

  async bumpAndPublishRevocationEpochChanged(
    transaction: Parameters<SessionAuthorizationPublisher["bumpAndPublishRevocationEpochChanged"]>[0],
    input: Parameters<SessionAuthorizationPublisher["bumpAndPublishRevocationEpochChanged"]>[1],
  ): Promise<string> {
    const sequence = await this.repository.reserveAndBumpRevocation(transaction, {
      siteRef: input.siteRef,
      expectedRevocationEpoch: BigInt(input.expectedRevocationEpoch),
      changedAt: input.changedAt,
    });
    const payload = create(AuthorizationEventSigningPayloadSchema, {
      eventId: this.eventId(),
      streamSequence: sequence.streamSequence,
      siteRef: input.siteRef,
      aggregateSequence: sequence.aggregateSequence,
      occurredAt: timestampFromDate(new Date(input.changedAt)),
      event: {
        case: "revocationEpochChanged",
        value: create(RevocationEpochChangedSchema, {
          revocationEpoch: sequence.revocationEpoch,
          reasonCode: input.reason,
        }),
      },
    });
    await this.append(transaction, payload, "revocation_epoch_changed", input.correlationId);
    return sequence.revocationEpoch.toString();
  }

  private async append(
    transaction: Parameters<SessionAuthorizationPublisher["publishGrantDelivered"]>[0],
    payload: AuthorizationEventSigningPayload,
    eventType: "grant_delivered" | "revocation_epoch_changed",
    correlationId: string,
  ): Promise<void> {
    const signingPayload = toBinary(AuthorizationEventSigningPayloadSchema, payload, {
      writeUnknownFields: false,
    });
    const payloadDigest = createHash("sha256").update(signingPayload).digest("hex");
    const signature = await this.signer.sign(signingPayload);
    await this.repository.append(transaction, {
      streamSequence: payload.streamSequence,
      eventId: payload.eventId,
      siteRef: payload.siteRef,
      aggregateSequence: payload.aggregateSequence,
      occurredAt: inputInstant(payload.occurredAt),
      signingPayload,
      payloadDigest,
      signingKeyRevision: this.signer.keyRevision,
      signature,
      eventType,
      correlationId,
    });
  }
}

function inputInstant(value: { seconds: bigint; nanos: number } | undefined): string {
  if (value === undefined) throw new Error("AUTHORIZATION_EVENT_TIME_REQUIRED");
  return new Date(Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000)).toISOString();
}
