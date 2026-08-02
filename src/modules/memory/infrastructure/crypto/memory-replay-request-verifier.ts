import { createHmac } from "node:crypto";
import type { MemoryReplayRequestVerifierPort } from
  "../../application/memory-authority-ports.js";
import type { MemoryCommandFingerprintInput } from "../../domain/memory-public.js";
import { MemoryApplicationError } from "../../application/memory-application-error.js";

const DOMAIN = Buffer.from("kokoro.memory.replay-request.v1\0", "utf8");
const MAX_FIELDS = 64;
const MAX_FRAME_BYTES = 65_536;

export type MemoryReplayRequestKeyRing = Readonly<{
  active: Readonly<{ keyRevision: string; key: Uint8Array }>;
  verifyOnly?: readonly Readonly<{ keyRevision: string; key: Uint8Array }>[];
}>;

export function createMemoryReplayRequestVerifier(
  input: MemoryReplayRequestKeyRing,
): MemoryReplayRequestVerifierPort {
  const entries = [input.active, ...(input.verifyOnly ?? [])];
  const keys = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]{3,128}$/u.test(entry.keyRevision) || entry.key.byteLength !== 32 ||
      keys.has(entry.keyRevision)) throw invalid();
    keys.set(entry.keyRevision, Buffer.from(entry.key));
  }
  const activeRevision = input.active.keyRevision;
  return Object.freeze({
    issue(value: MemoryCommandFingerprintInput, requestedRevision?: string) {
      const keyRevision = requestedRevision ?? activeRevision;
      const key = keys.get(keyRevision);
      if (key === undefined || typeof value.operation !== "string" || value.operation.length < 1 ||
        value.operation.length > 128 || /[\0\r\n]/u.test(value.operation)) throw invalid();
      const names = Object.keys(value.fields).sort();
      if (names.length > MAX_FIELDS) throw invalid();
      const hmac = createHmac("sha256", key).update(DOMAIN);
      appendFrame(hmac, "operation", value.operation);
      for (const name of names) {
        if (!/^[a-z][a-zA-Z0-9]*$/u.test(name)) throw invalid();
        const field = value.fields[name];
        const [type, encoded] = encodeField(field);
        appendFrame(hmac, `${name}:${type}`, encoded);
      }
      return Object.freeze({ keyRevision, digest: hmac.digest("hex") });
    },
  });
}

function encodeField(value: string | number | bigint | boolean | null | undefined):
  readonly [string, string] {
  if (value === null) return ["null", ""];
  if (typeof value === "string") return ["utf8", value];
  if (typeof value === "bigint") return ["int", value.toString(10)];
  if (typeof value === "boolean") return ["bool", value ? "true" : "false"];
  if (typeof value === "number" && Number.isSafeInteger(value)) return ["number", value.toString(10)];
  throw invalid();
}

function appendFrame(hmac: ReturnType<typeof createHmac>, name: string, value: string): void {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  if (nameBytes.byteLength > MAX_FRAME_BYTES || valueBytes.byteLength > MAX_FRAME_BYTES) throw invalid();
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(nameBytes.byteLength, 0);
  header.writeUInt32BE(valueBytes.byteLength, 4);
  hmac.update(header).update(nameBytes).update(valueBytes);
}

function invalid(): MemoryApplicationError {
  return new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}
