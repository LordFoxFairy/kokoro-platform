import { createHash, timingSafeEqual } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>;

const MAX_CANONICAL_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_IJSON_DEPTH = 128;
const MAX_IJSON_NODES = 100_000;

export interface ResolvedCanonicalDocument {
  readonly canonicalBytes: Uint8Array;
  readonly parsedDocument: unknown;
  readonly digest: string;
}

export interface VerifiedCanonicalDocument {
  readonly canonicalBytes: Uint8Array;
  readonly parsedDocument: CanonicalJsonValue;
  readonly digest: string;
}

/**
 * Revalidates all three facts returned by a publication resolver. The byte
 * representation is authoritative; the separately parsed value exists only to
 * make a resolver prove that it resolved the same immutable document.
 */
export function verifyCanonicalDocument(source: ResolvedCanonicalDocument): VerifiedCanonicalDocument {
  if (!(source.canonicalBytes instanceof Uint8Array) || source.canonicalBytes.byteLength < 2 ||
      source.canonicalBytes.byteLength > MAX_CANONICAL_DOCUMENT_BYTES) {
    throw new Error("PRODUCT_PUBLICATION_CANONICAL_BYTES_INVALID");
  }
  const bytes = new Uint8Array(source.canonicalBytes);
  const text = decodeUtf8(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("PRODUCT_PUBLICATION_CANONICAL_JSON_INVALID");
  }
  assertIJson(parsed);
  assertIJson(source.parsedDocument);
  const canonical = canonicalJson(parsed);
  const suppliedParsedCanonical = canonicalJson(source.parsedDocument as CanonicalJsonValue);
  if (canonical !== text || suppliedParsedCanonical !== canonical) {
    throw new Error("PRODUCT_PUBLICATION_CANONICAL_DOCUMENT_MISMATCH");
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(source.digest) || !safeEqual(digest, source.digest)) {
    throw new Error("PRODUCT_PUBLICATION_DOCUMENT_DIGEST_MISMATCH");
  }
  return Object.freeze({ canonicalBytes: bytes, parsedDocument: deepFreeze(parsed as CanonicalJsonValue), digest });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("PRODUCT_PUBLICATION_JSON_NUMBER_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("PRODUCT_PUBLICATION_JSON_VALUE_INVALID");
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function sameCanonicalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error("PRODUCT_PUBLICATION_CANONICAL_UTF8_INVALID");
  }
}

function assertIJson(root: unknown): void {
  const stack: { value: unknown; depth: number; ancestors: ReadonlySet<object> }[] =
    [{ value: root, depth: 0, ancestors: new Set<object>() }];
  let nodes = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_IJSON_NODES || frame.depth > MAX_IJSON_DEPTH) {
      throw new Error("PRODUCT_PUBLICATION_IJSON_COMPLEXITY_EXCEEDED");
    }
    const value = frame.value;
    if (typeof value === "string") {
      if (!hasOnlyUnicodeScalars(value) || value.normalize("NFC") !== value) {
        throw new Error("PRODUCT_PUBLICATION_IJSON_STRING_INVALID");
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("PRODUCT_PUBLICATION_IJSON_NUMBER_INVALID");
      continue;
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value !== "object") throw new Error("PRODUCT_PUBLICATION_IJSON_VALUE_INVALID");
    if (frame.ancestors.has(value)) throw new Error("PRODUCT_PUBLICATION_IJSON_CYCLE_INVALID");
    const ancestors = new Set(frame.ancestors);
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: frame.depth + 1, ancestors });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("PRODUCT_PUBLICATION_IJSON_OBJECT_INVALID");
    }
    for (const [key, item] of Object.entries(value)) {
      stack.push({ value: item, depth: frame.depth + 1, ancestors });
      stack.push({ value: key, depth: frame.depth + 1, ancestors });
    }
  }
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function deepFreeze<T>(value: T): T {
  const stack: object[] = value !== null && typeof value === "object" ? [value] : [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Object.isFrozen(current)) continue;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") stack.push(child);
    }
    Object.freeze(current);
  }
  return value;
}
