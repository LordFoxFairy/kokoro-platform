import { createHash } from "node:crypto";
import type {
  ImageEffectOutputAccessClaims,
  ImageEffectOutputTokenAuthority,
  ImageEffectSealedRecoveryEnvelope,
} from "../../application/image-effect-output-service.js";
import type {
  ModelGatewayResponseBinding,
  ModelGatewayResponseEnvelope,
  ModelGatewayResponseProtector,
} from "./response-protector.js";

const TOKEN_PREFIX = "kimg1.";
const MAXIMUM_TOKEN_BYTES = 32 * 1024;

export function createImageEffectOutputTokenAuthority(
  protector: ModelGatewayResponseProtector,
): ImageEffectOutputTokenAuthority {
  const authority: ImageEffectOutputTokenAuthority = {
    issue(claims) {
      validateClaims(claims);
      const claimsPlaintext = new TextEncoder().encode(canonical(claimsPayload(claims)));
      let tokenEnvelope: ModelGatewayResponseEnvelope;
      try { tokenEnvelope = protector.seal(claimsPlaintext, tokenBinding(claims)); }
      finally { claimsPlaintext.fill(0); }
      const routing = routingPayload(claims);
      const encoded = Buffer.from(canonical({ version: 1, routing, envelope: tokenEnvelope }), "utf8")
        .toString("base64url");
      const sourceAccessHandle = `${TOKEN_PREFIX}${encoded}`;
      if (sourceAccessHandle.length > MAXIMUM_TOKEN_BYTES) throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
      const recoveryPlaintext = new TextEncoder().encode(sourceAccessHandle);
      let recoveryEnvelope: ModelGatewayResponseEnvelope;
      try { recoveryEnvelope = protector.seal(recoveryPlaintext, recoveryBinding(claims)); }
      finally { recoveryPlaintext.fill(0); }
      return Object.freeze({ sourceAccessHandle,
        sourceAccessHandleDigest: sha256(sourceAccessHandle),
        recoveryEnvelope: Object.freeze(recoveryEnvelope) });
    },
    recover(rawEnvelope: ImageEffectSealedRecoveryEnvelope, claims: ImageEffectOutputAccessClaims) {
      validateClaims(claims);
      const plaintext = protector.unseal(responseEnvelope(rawEnvelope), recoveryBinding(claims));
      try {
        const sourceAccessHandle = new TextDecoder("utf8", { fatal: true }).decode(plaintext);
        const recoveredClaims = verifyToken(sourceAccessHandle, protector);
        if (canonical(claimsPayload(recoveredClaims)) !== canonical(claimsPayload(claims))) {
          throw new Error("IMAGE_EFFECT_OUTPUT_RECOVERY_BINDING_INVALID");
        }
        return sourceAccessHandle;
      } finally { plaintext.fill(0); }
    },
    verify(sourceAccessHandle: string) { return verifyToken(sourceAccessHandle, protector); },
  };
  return Object.freeze(authority);
}

function verifyToken(
  sourceAccessHandle: string,
  protector: ModelGatewayResponseProtector,
): ImageEffectOutputAccessClaims {
  if (!sourceAccessHandle.startsWith(TOKEN_PREFIX) || sourceAccessHandle.length > MAXIMUM_TOKEN_BYTES) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  const encoded = sourceAccessHandle.slice(TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  const serialized = Buffer.from(encoded, "base64url");
  if (serialized.toString("base64url") !== encoded || serialized.byteLength < 32) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  const container = parseObject(serialized.toString("utf8"));
  if (container.version !== 1) throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  const routing = parseRouting(container.routing);
  const envelope = responseEnvelope(container.envelope);
  const plaintext = protector.unseal(envelope, tokenBinding(routing));
  try {
    const claims = parseClaims(parseObject(new TextDecoder("utf8", { fatal: true }).decode(plaintext)));
    if (canonical(routingPayload(claims)) !== canonical(routing)) {
      throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_BINDING_INVALID");
    }
    return claims;
  } finally { plaintext.fill(0); }
}

function claimsPayload(claims: ImageEffectOutputAccessClaims): Readonly<Record<string, unknown>> {
  return Object.freeze({ capabilityRef: claims.capabilityRef, siteId: claims.siteId,
    callerIdentity: claims.callerIdentity, audience: claims.audience,
    logicalInvocationRef: claims.logicalInvocationRef, outputEvidenceRef: claims.outputEvidenceRef,
    outputEvidenceDigest: claims.outputEvidenceDigest, maxReadableBytes: claims.maxReadableBytes.toString(),
    expiresAt: claims.expiresAt, securityEpoch: claims.securityEpoch.toString() });
}

function routingPayload(claims: Pick<ImageEffectOutputAccessClaims, "capabilityRef" | "siteId" |
  "logicalInvocationRef" | "outputEvidenceRef" | "outputEvidenceDigest">): Readonly<Record<string, string>> {
  return Object.freeze({ capabilityRef: claims.capabilityRef, siteId: claims.siteId,
    logicalInvocationRef: claims.logicalInvocationRef, outputEvidenceRef: claims.outputEvidenceRef,
    outputEvidenceDigest: claims.outputEvidenceDigest });
}

function tokenBinding(claims: Pick<ImageEffectOutputAccessClaims, "capabilityRef" | "siteId" |
  "logicalInvocationRef" | "outputEvidenceRef" | "outputEvidenceDigest">): ModelGatewayResponseBinding {
  return Object.freeze({ siteId: claims.siteId, invocationRef: claims.logicalInvocationRef,
    requestDigest: sha256(["kokoro.image-effect.output-token.v1", claims.capabilityRef,
      claims.outputEvidenceRef, claims.outputEvidenceDigest].join("\0")), purpose: "response" });
}

function recoveryBinding(claims: ImageEffectOutputAccessClaims): ModelGatewayResponseBinding {
  return Object.freeze({ siteId: claims.siteId, invocationRef: claims.logicalInvocationRef,
    requestDigest: sha256(["kokoro.image-effect.output-recovery.v1", claims.capabilityRef,
      claims.outputEvidenceRef, claims.outputEvidenceDigest, claims.callerIdentity,
      claims.securityEpoch.toString()].join("\0")), purpose: "request" });
}

function parseClaims(value: Record<string, unknown>): ImageEffectOutputAccessClaims {
  const claims = Object.freeze({ capabilityRef: reference(value.capabilityRef), siteId: reference(value.siteId),
    callerIdentity: reference(value.callerIdentity), audience: value.audience,
    logicalInvocationRef: reference(value.logicalInvocationRef), outputEvidenceRef: reference(value.outputEvidenceRef),
    outputEvidenceDigest: digest(value.outputEvidenceDigest), maxReadableBytes: positiveBigint(value.maxReadableBytes),
    expiresAt: instant(value.expiresAt), securityEpoch: positiveBigint(value.securityEpoch) });
  if (claims.audience !== "platform-media-worker") throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  return Object.freeze({ ...claims, audience: "platform-media-worker" });
}

function parseRouting(value: unknown): Readonly<{
  capabilityRef: string;
  siteId: string;
  logicalInvocationRef: string;
  outputEvidenceRef: string;
  outputEvidenceDigest: string;
}> {
  if (!object(value)) throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  return Object.freeze({ capabilityRef: reference(value.capabilityRef), siteId: reference(value.siteId),
    logicalInvocationRef: reference(value.logicalInvocationRef), outputEvidenceRef: reference(value.outputEvidenceRef),
    outputEvidenceDigest: digest(value.outputEvidenceDigest) });
}

function validateClaims(claims: ImageEffectOutputAccessClaims): void {
  [claims.capabilityRef, claims.siteId, claims.callerIdentity, claims.logicalInvocationRef,
    claims.outputEvidenceRef].forEach(reference);
  digest(claims.outputEvidenceDigest);
  instant(claims.expiresAt);
  if (claims.audience !== "platform-media-worker" || claims.maxReadableBytes < 1n || claims.securityEpoch < 1n) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
}

function responseEnvelope(value: unknown): ModelGatewayResponseEnvelope {
  if (!object(value) || value.algorithm !== "A256GCM") {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return Object.freeze({ algorithm: "A256GCM", keyRevision: tokenText(value.keyRevision),
    nonce: tokenText(value.nonce), ciphertext: tokenText(value.ciphertext),
    authenticationTag: tokenText(value.authenticationTag) });
}

function parseObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID"); }
  if (!object(parsed)) throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  return parsed;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reference(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return value;
}

function tokenText(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,65536}$/u.test(value)) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return value;
}

function positiveBigint(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return BigInt(value);
}

function instant(value: unknown): string {
  if (typeof value !== "string") throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("IMAGE_EFFECT_OUTPUT_TOKEN_INVALID");
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}
