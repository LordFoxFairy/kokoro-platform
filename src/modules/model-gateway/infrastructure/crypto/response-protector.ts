import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAXIMUM_PLAINTEXT_BYTES = 12 * 1024 * 1024;

export type ModelGatewayResponseBinding = Readonly<{
  siteId: string;
  invocationRef: string;
  requestDigest: string;
  purpose?: "request" | "frame" | "response";
  sequence?: bigint;
  previousFrameDigest?: string;
}>;

export type ModelGatewayResponseEnvelope = Readonly<{
  algorithm: "A256GCM";
  keyRevision: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}>;

export interface ModelGatewayResponseProtector {
  seal(plaintext: Uint8Array, binding: ModelGatewayResponseBinding): ModelGatewayResponseEnvelope;
  unseal(envelope: ModelGatewayResponseEnvelope, binding: ModelGatewayResponseBinding): Uint8Array;
}

export function createModelGatewayResponseProtector(config: Readonly<{
  currentKeyRevision: string;
  keys: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}>): ModelGatewayResponseProtector {
  const keys = new Map<string, Uint8Array>();
  for (const item of config.keys) {
    if (!revision(item.keyRevision) || item.key.byteLength !== 32 || keys.has(item.keyRevision)) {
      throw new Error("MODEL_GATEWAY_RESPONSE_KEY_RING_INVALID");
    }
    keys.set(item.keyRevision, Uint8Array.from(item.key));
  }
  if (!revision(config.currentKeyRevision) || !keys.has(config.currentKeyRevision)) {
    throw new Error("MODEL_GATEWAY_RESPONSE_KEY_RING_INVALID");
  }
  return Object.freeze({
    seal(plaintext: Uint8Array, binding: ModelGatewayResponseBinding) {
      assertBinding(binding);
      if (plaintext.byteLength < 1 || plaintext.byteLength > MAXIMUM_PLAINTEXT_BYTES) {
        throw new Error("MODEL_GATEWAY_RESPONSE_PLAINTEXT_INVALID");
      }
      const key = keys.get(config.currentKeyRevision);
      if (key === undefined) throw new Error("MODEL_GATEWAY_RESPONSE_KEY_RING_INVALID");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      cipher.setAAD(aad(config.currentKeyRevision, binding));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        algorithm: "A256GCM" as const,
        keyRevision: config.currentKeyRevision,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authenticationTag: cipher.getAuthTag().toString("base64url"),
      });
    },
    unseal(envelope: ModelGatewayResponseEnvelope, binding: ModelGatewayResponseBinding) {
      assertBinding(binding);
      if (envelope.algorithm !== "A256GCM") throw new Error("MODEL_GATEWAY_RESPONSE_ENVELOPE_INVALID");
      const key = keys.get(envelope.keyRevision);
      if (key === undefined) throw new Error("MODEL_GATEWAY_RESPONSE_KEY_REVISION_UNKNOWN");
      const nonce = canonicalBase64url(envelope.nonce, 12);
      const tag = canonicalBase64url(envelope.authenticationTag, 16);
      const ciphertext = canonicalBase64url(envelope.ciphertext, null);
      if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAXIMUM_PLAINTEXT_BYTES) {
        throw new Error("MODEL_GATEWAY_RESPONSE_ENVELOPE_INVALID");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad(envelope.keyRevision, binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return Uint8Array.from(plaintext);
    },
  });
}

function aad(keyRevision: string, binding: ModelGatewayResponseBinding): Buffer {
  const purpose = binding.purpose ?? "response";
  return Buffer.from([
    "kokoro.model-gateway.envelope.v2",
    keyRevision,
    purpose,
    binding.siteId,
    binding.invocationRef,
    binding.requestDigest,
    binding.sequence?.toString() ?? "",
    binding.previousFrameDigest ?? "",
  ].join("\0"), "utf8");
}

function assertBinding(binding: ModelGatewayResponseBinding): void {
  if (!/^[0-9a-f]{64}$/u.test(binding.requestDigest) ||
      [binding.siteId, binding.invocationRef].some((value) =>
        value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value))) {
    throw new Error("MODEL_GATEWAY_RESPONSE_BINDING_INVALID");
  }
  const purpose = binding.purpose ?? "response";
  if (purpose === "frame") {
    if (binding.sequence === undefined || binding.sequence < 1n ||
        binding.previousFrameDigest === undefined ||
        !/^[0-9a-f]{64}$/u.test(binding.previousFrameDigest)) {
      throw new Error("MODEL_GATEWAY_RESPONSE_BINDING_INVALID");
    }
  } else if (binding.sequence !== undefined || binding.previousFrameDigest !== undefined) {
    throw new Error("MODEL_GATEWAY_RESPONSE_BINDING_INVALID");
  }
}

function revision(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function canonicalBase64url(value: string, expectedBytes: number | null): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("MODEL_GATEWAY_RESPONSE_ENVELOPE_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value ||
      (expectedBytes !== null && decoded.byteLength !== expectedBytes)) {
    throw new Error("MODEL_GATEWAY_RESPONSE_ENVELOPE_INVALID");
  }
  return decoded;
}
