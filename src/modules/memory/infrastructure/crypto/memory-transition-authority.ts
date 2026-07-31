import { createHmac } from "node:crypto";
import { MemoryApplicationError } from "../../application/memory-application-error.js";
import type { MemoryTransitionAuthorityPort } from "../../application/memory-authority-ports.js";

const DOMAIN = "kokoro.memory.transition.v1\0";
const MAX_CANONICAL_PAYLOAD_BYTES = 131_072;

export function createMemoryTransitionAuthority(input: Readonly<{
  keyRevision: string;
  key: Uint8Array;
}>): MemoryTransitionAuthorityPort {
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(input.keyRevision) || input.key.byteLength !== 32) {
    throw invalid();
  }
  const key = Buffer.from(input.key);
  const keyRevision = input.keyRevision;
  return Object.freeze({
    async issue(value: Readonly<{ canonicalPayload: string }>) {
      if (typeof value.canonicalPayload !== "string" ||
        Buffer.byteLength(value.canonicalPayload, "utf8") > MAX_CANONICAL_PAYLOAD_BYTES) {
        throw invalid();
      }
      return Object.freeze({ keyRevision, digest: createHmac("sha256", key)
        .update(DOMAIN, "utf8").update(value.canonicalPayload, "utf8").digest("hex") });
    },
  });
}

function invalid(): MemoryApplicationError {
  return new MemoryApplicationError("MEMORY_PERSISTENCE_CONFLICT");
}
