import { createHash } from "node:crypto";

export function authorizationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function credentialDigest(value: string): string {
  return createHash("sha256")
    .update("kokoro.platform.user-session.v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function signedCredentialDigest(value: string): string {
  return createHash("sha256")
    .update("kokoro.platform.session-access-grant.v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("AUTHORIZATION_CANONICAL_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("AUTHORIZATION_CANONICAL_VALUE_INVALID");
}
