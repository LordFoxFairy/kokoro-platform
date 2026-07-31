import { createHash } from "node:crypto";
import { MemoryDomainError } from "./memory-error.js";
import { memoryDigest, type MemoryDigest } from "./memory-references.js";

const commandDigestDomain = "kokoro.memory.command.v1";

export type MemoryCommandDigestField = readonly [name: string, value: string | bigint];

export function computeCanonicalMemoryCommandDigest(operation: string,
  fields: readonly MemoryCommandDigestField[]): MemoryDigest {
  const hash = createHash("sha256");
  appendFrame(hash, "domain", commandDigestDomain);
  appendFrame(hash, "operation", operation);
  for (const [name, rawValue] of fields) {
    if (!/^[a-z][a-zA-Z0-9]*$/u.test(name)) throw new MemoryDomainError("MEMORY_DIGEST_INVALID");
    const type = typeof rawValue === "bigint" ? "int8" : "utf8";
    const value = typeof rawValue === "bigint" ? rawValue.toString(10) : rawValue;
    appendFrame(hash, `${name}:${type}`, value);
  }
  return memoryDigest(hash.digest("hex"));
}

function appendFrame(hash: ReturnType<typeof createHash>, name: string, value: string): void {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(nameBytes.byteLength, 0);
  header.writeUInt32BE(valueBytes.byteLength, 4);
  hash.update(header);
  hash.update(nameBytes);
  hash.update(valueBytes);
}
