import { createHmac, timingSafeEqual } from "node:crypto";
import type { ClaimedOutboxEvent, OutboxDeliveryAcknowledgement } from "./outbox.js";
import type { JsonValue } from "./receipt.js";

export interface OutboxDeliveryTransport {
  publish(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<OutboxDeliveryAcknowledgement>;
}

export class OutboxDeliveryTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "OutboxDeliveryTransportError";
  }
}

export class HmacHttpOutboxDeliveryTransport implements OutboxDeliveryTransport {
  readonly #endpoint: URL;
  readonly #keyId: string;
  readonly #secret: Buffer;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #canonicalJson: (value: JsonValue) => string;

  constructor(input: Readonly<{
    endpoint: string;
    keyId: string;
    secretBase64: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    canonicalJson?: (value: JsonValue) => string;
  }>) {
    this.#endpoint = new URL(input.endpoint);
    if (
      this.#endpoint.protocol !== "https:" ||
      this.#endpoint.username.length > 0 ||
      this.#endpoint.password.length > 0 ||
      this.#endpoint.hash.length > 0
    ) throw new Error("OUTBOX_DELIVERY_HTTPS_REQUIRED");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.keyId)) {
      throw new Error("OUTBOX_DELIVERY_KEY_ID_INVALID");
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input.secretBase64)) {
      throw new Error("OUTBOX_DELIVERY_SECRET_INVALID");
    }
    this.#secret = Buffer.from(input.secretBase64, "base64");
    const canonicalSecret = input.secretBase64.replace(/=+$/u, "");
    if (
      this.#secret.byteLength < 32 ||
      this.#secret.toString("base64").replace(/=+$/u, "") !== canonicalSecret
    ) throw new Error("OUTBOX_DELIVERY_SECRET_INVALID");
    this.#keyId = input.keyId;
    this.#fetch = input.fetch ?? fetch;
    this.#canonicalJson = input.canonicalJson ?? canonicalOutboxJson;
    this.#timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 60_000) {
      throw new Error("OUTBOX_DELIVERY_TIMEOUT_INVALID");
    }
  }

  async publish(
    event: ClaimedOutboxEvent,
    signal: AbortSignal,
  ): Promise<OutboxDeliveryAcknowledgement> {
    const body = this.#canonicalJson({
      eventId: event.eventId,
      owner: event.owner,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      payloadDigest: event.payloadDigest,
      correlationId: event.correlationId,
      causationId: event.causationId,
    });
    let response: Response;
    const transportSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.#timeoutMs),
    ]);
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kokoro-delivery-key-id": this.#keyId,
          "x-kokoro-delivery-signature": mac(this.#secret, body),
          "x-kokoro-idempotency-key": event.eventId,
        },
        body,
        redirect: "error",
        signal: transportSignal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const timeout = error instanceof DOMException && error.name === "TimeoutError";
      throw new OutboxDeliveryTransportError(
        timeout ? "OUTBOX_DELIVERY_TIMEOUT" : "OUTBOX_DELIVERY_NETWORK_FAILED",
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new OutboxDeliveryTransportError(
        `OUTBOX_DELIVERY_HTTP_${response.status}`,
        retryableStatus(response.status),
      );
    }
    let value: unknown;
    try {
      value = await boundedJson(response, 16 * 1024);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      if (error instanceof OutboxAcknowledgementStreamError || transportSignal.aborted) {
        throw new OutboxDeliveryTransportError(
          "OUTBOX_DELIVERY_ACK_OUTCOME_UNKNOWN",
          true,
        );
      }
      throw new OutboxDeliveryTransportError("OUTBOX_DELIVERY_ACK_INVALID", false);
    }
    if (
      !isRecord(value) ||
      value.eventId !== event.eventId ||
      !bounded(value.deliveryId, 128) ||
      typeof value.acknowledgedAt !== "string" ||
      !Number.isFinite(Date.parse(value.acknowledgedAt)) ||
      typeof value.acknowledgementMac !== "string"
    ) throw new OutboxDeliveryTransportError("OUTBOX_DELIVERY_ACK_INVALID", false);
    const acknowledgedAt = new Date(value.acknowledgedAt).toISOString();
    const expected = mac(this.#secret, this.#canonicalJson({
      eventId: event.eventId,
      deliveryId: value.deliveryId,
      acknowledgedAt,
      payloadDigest: event.payloadDigest,
    }));
    if (!safeEqual(value.acknowledgementMac, expected)) {
      throw new OutboxDeliveryTransportError("OUTBOX_DELIVERY_ACK_SIGNATURE_INVALID", false);
    }
    return Object.freeze({ deliveryId: value.deliveryId, acknowledgedAt });
  }
}

export function canonicalOutboxJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOutboxJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalOutboxJson(value[key]!)}`).join(",")}}`;
}

function mac(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("OUTBOX_DELIVERY_ACK_TOO_LARGE");
  }
  if (response.body === null) throw new Error("OUTBOX_DELIVERY_ACK_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await reader.read();
      } catch (error) {
        throw new OutboxAcknowledgementStreamError(error);
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OUTBOX_DELIVERY_ACK_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

class OutboxAcknowledgementStreamError extends Error {
  constructor(readonly cause: unknown) {
    super("OUTBOX_DELIVERY_ACK_STREAM_FAILED");
    this.name = "OutboxAcknowledgementStreamError";
  }
}
