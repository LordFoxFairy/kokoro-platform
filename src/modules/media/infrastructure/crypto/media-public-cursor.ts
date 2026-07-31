import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  DecodedMediaPublicCursor,
  MediaPublicCursorCodec,
  MediaPublicCursorExpectation,
  MediaPublicCursorInput,
  ResolvedMediaPublicOwnerAuthority,
} from
  "../../application/contracts/media-public-read-ports.js";

const DOMAIN = "kokoro.platform.media-public-cursor.v1\0";
const TOKEN = /^[A-Za-z0-9_-]{1,1400}\.[A-Za-z0-9_-]{43}$/u;
const common = {
  v: z.literal(1),
  ref: z.string().min(1).max(256),
};
const payloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("definition"), published_at: z.iso.datetime() }),
  z.strictObject({ ...common, kind: z.literal("operation"), created_at: z.iso.datetime() }),
  z.strictObject({ ...common, kind: z.literal("model_option"),
    definition_ref: z.string().min(1).max(256), position: z.number().int().min(0).max(255) }),
]);

export class HmacMediaPublicCursorCodec implements MediaPublicCursorCodec {
  readonly #key: Uint8Array;
  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("MEDIA_PUBLIC_CURSOR_KEY_INVALID");
    this.#key = new Uint8Array(key);
  }

  encode(input: MediaPublicCursorInput): string {
    const commonPayload = { v: 1 as const, kind: input.kind, ref: input.ref };
    const payload = input.kind === "definition"
      ? { ...commonPayload, published_at: canonicalInstant(input.publishedAt) }
      : input.kind === "operation"
        ? { ...commonPayload, created_at: canonicalInstant(input.createdAt) }
        : { ...commonPayload, definition_ref: reference(input.definitionRef),
            position: boundedPosition(input.position) };
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = sign(this.#key, bytes, input.owner);
    return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
  }

  decode(value: string, expected: MediaPublicCursorExpectation): DecodedMediaPublicCursor {
    try {
      if (!TOKEN.test(value)) throw invalid();
      const [encoded, encodedSignature] = value.split(".");
      const bytes = Buffer.from(encoded!, "base64url");
      const signature = Buffer.from(encodedSignature!, "base64url");
      const calculated = sign(this.#key, bytes, expected.owner);
      if (signature.byteLength !== calculated.byteLength || !timingSafeEqual(signature, calculated)) throw invalid();
      const payload = payloadSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
      if (payload.kind !== expected.kind) throw invalid();
      if (payload.kind === "definition") return Object.freeze({ kind: payload.kind,
        publishedAt: payload.published_at, ref: payload.ref });
      if (payload.kind === "operation") return Object.freeze({ kind: payload.kind,
        createdAt: payload.created_at, ref: payload.ref });
      if (expected.kind !== "model_option" || payload.definition_ref !== expected.definitionRef) throw invalid();
      return Object.freeze({ kind: payload.kind, position: payload.position, ref: payload.ref });
    } catch (error) {
      if (error instanceof Error && error.message === "MEDIA_PAGE_CURSOR_INVALID") throw error;
      throw invalid();
    }
  }
}

function sign(key: Uint8Array, bytes: Uint8Array, owner: ResolvedMediaPublicOwnerAuthority): Buffer {
  const hmac = createHmac("sha256", key).update(DOMAIN, "utf8");
  for (const value of [owner.siteRef, owner.siteReleaseRef, owner.siteProjectBindingRef,
    owner.deploymentRef, owner.workloadIdentityRef, owner.workloadBindingEpoch.toString(),
    owner.siteSecurityEpoch.toString(), owner.policyEpoch.toString(), owner.environment,
    owner.region, owner.audience, owner.subjectRef, owner.subjectGeneration.toString(),
    owner.identitySessionRef, owner.identitySessionEpoch.toString(), owner.restrictionEpoch.toString(),
    owner.credentialEpoch.toString(), owner.projectRef, owner.membershipEpoch.toString(),
    owner.authorizationEpoch.toString(), owner.modelOptionCatalogRef]) {
    hmac.update(frame(Buffer.from(value, "utf8")));
  }
  return hmac.update(frame(bytes)).digest();
}
function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  return Buffer.concat([length, value]);
}
function canonicalInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  return date.toISOString();
}
function boundedPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw invalid();
  return value;
}
function reference(value: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || /[\0\r\n]/u.test(value)) throw invalid();
  return value;
}
function invalid(): Error { return new Error("MEDIA_PAGE_CURSOR_INVALID"); }
