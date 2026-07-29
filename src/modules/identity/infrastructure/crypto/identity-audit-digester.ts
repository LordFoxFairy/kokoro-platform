import { createHmac } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { IdentityAuditDigesterPort } from "../../application/contracts/identity-security-ports.js";

export function createIdentityAuditDigester(key: Uint8Array): IdentityAuditDigesterPort {
  if (key.byteLength < 32) throw new Error("IDENTITY_AUDIT_DIGEST_KEY_INVALID");
  const ownedKey = Uint8Array.from(key);
  return (value) => createHmac("sha256", ownedKey)
    .update("kokoro.identity.audit.v1\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("IDENTITY_AUDIT_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}
