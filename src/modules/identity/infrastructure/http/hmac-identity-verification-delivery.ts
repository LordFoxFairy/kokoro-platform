import type {
  IdentityVerificationDeliveryEffect,
  IdentityVerificationDeliveryPort,
} from "../../application/services/identity-outbox-consumer.js";
import {
  HmacHttpOutboxDeliveryTransport,
  OutboxDeliveryTransportError,
} from "../../../../shared/outbox-inbox/hmac-http-delivery.js";

export class IdentityVerificationDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "IdentityVerificationDeliveryError";
  }
}

export class HmacIdentityVerificationDeliveryAdapter
implements IdentityVerificationDeliveryPort {
  readonly #transport: HmacHttpOutboxDeliveryTransport;

  constructor(input: ConstructorParameters<typeof HmacHttpOutboxDeliveryTransport>[0]) {
    this.#transport = new HmacHttpOutboxDeliveryTransport(input);
  }

  async publish(
    effect: IdentityVerificationDeliveryEffect,
    signal: AbortSignal,
  ) {
    try {
      return await this.#transport.publish({
        eventId: effect.eventId,
        owner: "identity",
        eventType: "identity.verification.delivery.requested",
        aggregateId: effect.aggregateId,
        payload: effect.payload,
        payloadDigest: effect.payloadDigest,
        correlationId: effect.correlationId,
        causationId: effect.causationId,
        leaseToken: effect.leaseToken,
        attempt: effect.attempt,
      }, signal);
    } catch (error) {
      if (!(error instanceof OutboxDeliveryTransportError)) throw error;
      throw new IdentityVerificationDeliveryError(
        error.code.replace(/^OUTBOX_DELIVERY/u, "IDENTITY_DELIVERY"),
        error.retryable,
      );
    }
  }
}
