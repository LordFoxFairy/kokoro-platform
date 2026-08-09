import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommerceAdministrationComposition } from
  "../../src/process/commerce-admin-composition.js";

describe("production Commerce administration composition", () => {
  it.each([{}, { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: "" }])(
    "fails closed before constructing a provider when its redemption key ring is absent",
    async (environment) => {
      await expect(createCommerceAdministrationComposition({
        database: {} as never,
        environment,
      })).rejects.toThrowError("PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE_REQUIRED");
    },
  );

  it("reads a real 0440 Kubernetes AtomicWriter key ring through its bounded trust root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-admin-commerce-atomic-"));
    try {
      const revisionName = "..2026_08_09_03_15_00.000000001";
      const revision = join(root, revisionName);
      await mkdir(revision);
      await writeKeyRing(join(revision, "commerce-redemption-keys.json"), 0o440);
      await symlink(revisionName, join(root, "..data"));
      await symlink("..data/commerce-redemption-keys.json",
        join(root, "commerce-redemption-keys.json"));

      await expect(compose(join(root, "commerce-redemption-keys.json")))
        .resolves.toMatchObject({ commerce: expect.anything(), reader: expect.anything() });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([0o400, 0o600])(
    "reads a regular %s key ring used by the Compose read-only bind",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "kokoro-admin-commerce-bind-"));
      try {
        const path = join(root, "commerce-redemption-keys.json");
        await writeKeyRing(path, mode);

        await expect(compose(path)).resolves.toMatchObject({
          commerce: expect.anything(),
          reader: expect.anything(),
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a key ring symlink that leaves its trusted parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-admin-commerce-root-"));
    const outside = await mkdtemp(join(tmpdir(), "kokoro-admin-commerce-outside-"));
    try {
      const external = join(outside, "commerce-redemption-keys.json");
      await writeKeyRing(external, 0o400);
      const path = join(root, "commerce-redemption-keys.json");
      await symlink(external, path);

      await expect(compose(path)).rejects.toThrowError("REDEMPTION_KEY_RING_FILE_INVALID");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("rejects a key ring below a group-or-world-writable trust root", async () => {
    const root = await mkdtemp(join(tmpdir(), "kokoro-admin-commerce-unsafe-root-"));
    try {
      const path = join(root, "commerce-redemption-keys.json");
      await writeKeyRing(path, 0o400);
      await chmod(root, 0o777);

      await expect(compose(path)).rejects.toThrowError(
        "PLATFORM_COMMERCE_REDEMPTION_KEY_RING_TRUST_ROOT_INVALID",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function compose(path: string) {
  return createCommerceAdministrationComposition({
    database: {} as never,
    environment: { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: path },
  });
}

function writeKeyRing(path: string, mode: number): Promise<void> {
  const secret = (fill: number) => Buffer.alloc(32, fill).toString("base64url");
  return writeFile(path, JSON.stringify({
    version: 1,
    currentCodeLookupKeyRevision: "admin-code-v1",
    codeLookupKeys: [{ keyRevision: "admin-code-v1", keyBase64url: secret(1) }],
    currentPreviewCredentialKeyRevision: "admin-preview-v1",
    previewCredentialKeys: [{ keyRevision: "admin-preview-v1", keyBase64url: secret(2) }],
    requestAuditKeyBase64url: secret(3),
  }), { encoding: "utf8", mode });
}
