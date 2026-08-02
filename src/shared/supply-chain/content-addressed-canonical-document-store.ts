import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedCanonicalDocument } from
  "../../modules/product-catalog/domain/canonical-product-document.js";

const MAXIMUM_DOCUMENT_BYTES = 4 * 1024 * 1024;

export class ContentAddressedCanonicalDocumentStore {
  readonly #root: string;
  readonly #maximumBytes: number;

  constructor(root: string, options: Readonly<{ maximumBytes?: number }> = {}) {
    if (root.length < 1) throw new Error("PUBLICATION_DOCUMENT_ROOT_INVALID");
    const maximumBytes = options.maximumBytes ?? MAXIMUM_DOCUMENT_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > MAXIMUM_DOCUMENT_BYTES) {
      throw new Error("PUBLICATION_DOCUMENT_MAXIMUM_INVALID");
    }
    this.#root = resolve(root);
    this.#maximumBytes = maximumBytes;
  }

  async read(
    digest: string,
    expected: string | Readonly<{ field: string; value: string }>,
  ): Promise<ResolvedCanonicalDocument> {
    const digestHex = hex(digest);
    const path = resolve(this.#root, "sha256", `${digestHex}.json`);
    const handle = await openNoFollow(path);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("PUBLICATION_DOCUMENT_NOT_REGULAR");
      if (before.size < 2 || before.size > this.#maximumBytes) {
        throw new Error("PUBLICATION_DOCUMENT_SIZE_INVALID");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          bytes.byteLength !== before.size) throw new Error("PUBLICATION_DOCUMENT_CHANGED_DURING_READ");
      let parsedDocument: unknown;
      try {
        parsedDocument = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        throw new Error("PUBLICATION_DOCUMENT_JSON_INVALID");
      }
      const discriminator = typeof expected === "string"
        ? { field: "contract", value: expected } : expected;
      if (field(parsedDocument, discriminator.field) !== discriminator.value) {
        throw new Error("PUBLICATION_DOCUMENT_KIND_MISMATCH");
      }
      return Object.freeze({ canonicalBytes: new Uint8Array(bytes), parsedDocument, digest });
    } finally {
      await handle.close();
    }
  }
}

async function openNoFollow(path: string) {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ELOOP") {
      throw new Error("PUBLICATION_DOCUMENT_NOT_REGULAR");
    }
    throw cause;
  }
}
function hex(value: string): string {
  const match = /^sha256:([a-f0-9]{64})$/u.exec(value);
  if (match?.[1] === undefined) throw new Error("PUBLICATION_DOCUMENT_DIGEST_INVALID");
  return match[1];
}
function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[name] : undefined;
}
