import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedProductPublicationDocumentResolver } from
  "../../src/modules/product-catalog/infrastructure/filesystem/content-addressed-product-publication-document-resolver.js";

describe("content-addressed Product publication document resolver", () => {
  it("loads only the exact digest-addressed canonical object", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-product-publication-"));
    const bytes = Buffer.from('{"contract":"kokoro.product-surface-catalog.v1"}', "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(root, "sha256"), { recursive: true });
    await writeFile(join(root, "sha256", `${digest}.json`), bytes);
    const resolver = new ContentAddressedProductPublicationDocumentResolver(root);

    const result = await resolver.resolve({
      kind: "product-surface-catalog",
      binding: { ref: "catalog.main", revision: 1n, digest: `sha256:${digest}` },
    });

    expect(Buffer.from(result.canonicalBytes)).toEqual(bytes);
    expect(result.parsedDocument).toEqual({ contract: "kokoro.product-surface-catalog.v1" });
    expect(result.digest).toBe(`sha256:${digest}`);
  });

  it("rejects symlinks, digest drift, oversize values and contract-kind substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-product-publication-"));
    await mkdir(join(root, "sha256"), { recursive: true });
    const resolver = new ContentAddressedProductPublicationDocumentResolver(root, { maximumBytes: 64 });
    const bytes = Buffer.from('{"contract":"kokoro.launch-product-profile.v1"}', "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const outside = join(root, "outside.json");
    await writeFile(outside, bytes);
    await symlink(outside, join(root, "sha256", `${digest}.json`));

    await expect(resolver.resolve({
      kind: "product-surface-catalog",
      binding: { ref: "catalog.main", revision: 1n, digest: `sha256:${digest}` },
    })).rejects.toThrow("PRODUCT_PUBLICATION_DOCUMENT_NOT_REGULAR");

    const large = Buffer.from(`{"contract":"kokoro.product-surface-catalog.v1","x":"${"a".repeat(64)}"}`);
    const largeDigest = createHash("sha256").update(large).digest("hex");
    await writeFile(join(root, "sha256", `${largeDigest}.json`), large);
    await expect(resolver.resolve({
      kind: "product-surface-catalog",
      binding: { ref: "catalog.main", revision: 1n, digest: `sha256:${largeDigest}` },
    })).rejects.toThrow("PRODUCT_PUBLICATION_DOCUMENT_SIZE_INVALID");
  });
});
