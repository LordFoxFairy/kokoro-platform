import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "kokoro.platform.artifact-owner-cursor.v1\0";
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/u;

export interface ArtifactOwnerCursorCodec {
  encode(value: Readonly<Record<string, string>>): string;
  decode(value: string): Readonly<Record<string, string>>;
}

/** Independent owner-cursor authority; never accepts the delivery bearer key. */
export class HmacArtifactOwnerCursorCodec implements ArtifactOwnerCursorCodec {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error("ARTIFACT_OWNER_CURSOR_KEY_INVALID");
    }
    this.#key = Buffer.from(key);
  }

  encode(value: Readonly<Record<string, string>>): string {
    const payload = Buffer.from(canonicalPayload(value), "utf8")
      .toString("base64url");
    const result = `${payload}.${this.#signature(payload)}`;
    if (result.length > 2048) throw new Error("PAGE_CURSOR_INVALID");
    return result;
  }

  decode(value: string): Readonly<Record<string, string>> {
    const match = TOKEN_PATTERN.exec(value);
    if (match === null) throw new Error("PAGE_CURSOR_INVALID");
    const expected = Buffer.from(this.#signature(match[1]!), "base64url");
    const supplied = Buffer.from(match[2]!, "base64url");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("PAGE_CURSOR_INVALID");
    }
    const decoded = Buffer.from(match[1]!, "base64url");
    if (decoded.toString("base64url") !== match[1]) throw new Error("PAGE_CURSOR_INVALID");
    let raw: unknown;
    try {
      raw = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new Error("PAGE_CURSOR_INVALID");
    }
    if (!record(raw) || raw.v !== 1) {
      throw new Error("PAGE_CURSOR_INVALID");
    }
    const { v: _version, ...payload } = raw;
    if (canonicalPayload(payload as Record<string, string>) !== decoded.toString("utf8")) {
      throw new Error("PAGE_CURSOR_INVALID");
    }
    return Object.freeze(payload as Record<string, string>);
  }

  #signature(value: string): string {
    return createHmac("sha256", this.#key).update(DOMAIN).update(value).digest("base64url");
  }
}

function canonicalPayload(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (entries.length < 1 || entries.length > 8 || entries.some(([name, item]) =>
    !/^[a-z][a-z_]{0,31}$/u.test(name) || typeof item !== "string" ||
    item.length < 1 || item.length > 256)) {
    throw new Error("PAGE_CURSOR_INVALID");
  }
  return JSON.stringify(Object.fromEntries([["v", 1], ...entries]));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
