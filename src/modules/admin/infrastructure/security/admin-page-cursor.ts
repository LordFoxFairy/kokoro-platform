import { createHmac, timingSafeEqual } from "node:crypto";
import type { AdminPageCursorCodec } from "../../interfaces/connect/admin-query-service.js";

const CONTEXT = "kokoro.admin-page-cursor.v1";

export class HmacAdminPageCursorCodec implements AdminPageCursorCodec {
  constructor(private readonly key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error("ADMIN_PAGE_CURSOR_KEY_INVALID");
    }
  }

  encode(value: Readonly<Record<string, string>>): string {
    const canonical = canonicalPayload(value);
    const encoded = Buffer.from(canonical, "utf8").toString("base64url");
    return `${encoded}.${this.signature(encoded)}`;
  }

  decode(value: string): Readonly<Record<string, string>> {
    if (value.length < 3 || value.length > 1024 || value.split(".").length !== 2) {
      throw new Error("ADMIN_PAGE_TOKEN_INVALID");
    }
    const [encoded, signature] = value.split(".") as [string, string];
    const expected = this.signature(encoded);
    const receivedBytes = Buffer.from(signature, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    if (receivedBytes.byteLength !== expectedBytes.byteLength ||
        !timingSafeEqual(receivedBytes, expectedBytes)) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error("ADMIN_PAGE_TOKEN_INVALID");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ADMIN_PAGE_TOKEN_INVALID");
    }
    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || Object.entries(record).some(([key, item]) =>
      key !== "v" && (typeof item !== "string" || item.length < 1 || item.length > 256))) {
      throw new Error("ADMIN_PAGE_TOKEN_INVALID");
    }
    const { v: _version, ...payload } = record;
    return Object.freeze(payload as Record<string, string>);
  }

  private signature(value: string): string {
    return createHmac("sha256", this.key).update(CONTEXT).update("\0").update(value).digest("base64url");
  }
}

function canonicalPayload(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length < 1 || entries.length > 8 || entries.some(([key, item]) =>
    !/^[a-z][a-z_]{0,31}$/u.test(key) || item.length < 1 || item.length > 256)) {
    throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  }
  return JSON.stringify(Object.fromEntries([["v", 1], ...entries]));
}
