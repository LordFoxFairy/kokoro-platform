import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadIdentityTotpSecretProtector } from "../../src/process/platform-public-composition.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Identity TOTP key-ring startup configuration", () => {
  it("loads an exact private key-ring file and supports current-key encryption", async () => {
    const path = await keyRingFile(0o600);
    const protector = await loadIdentityTotpSecretProtector(path);
    const binding = {
      siteRef: "site-1",
      accountRef: "account-1",
      subjectRef: "subject-1",
      authenticatorRef: "factor-1",
    };
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const envelope = protector.seal(secret, binding);

    expect(envelope.keyRevision).toBe("totp-key-1");
    expect(protector.unseal(envelope, binding)).toBe(secret);
  });

  it("rejects group/world-readable files and symbolic links", async () => {
    const publicPath = await keyRingFile(0o644);
    const directory = await temporaryDirectory();
    const linkPath = join(directory, "totp-link.json");
    await symlink(publicPath, linkPath);

    await expect(loadIdentityTotpSecretProtector(publicPath)).rejects.toThrow(
      "IDENTITY_TOTP_KEY_RING_PERMISSIONS_INVALID",
    );
    await expect(loadIdentityTotpSecretProtector(linkPath)).rejects.toThrow(
      "IDENTITY_TOTP_KEY_RING_PERMISSIONS_INVALID",
    );
  });

  it("rejects unknown fields, duplicate revisions and non-canonical key material", async () => {
    const unknownField = await keyRingFile(0o600, { extra: true });
    await expect(loadIdentityTotpSecretProtector(unknownField)).rejects.toThrow(
      "IDENTITY_SECRET_CONFIG_UNKNOWN_FIELD",
    );

    const duplicate = await keyRingFile(0o600, {
      keys: [key("totp-key-1", 7), key("totp-key-1", 8)],
    });
    await expect(loadIdentityTotpSecretProtector(duplicate)).rejects.toThrow(
      "IDENTITY_TOTP_KEY_RING_INVALID",
    );

    const invalid = await keyRingFile(0o600, {
      keys: [{ keyRevision: "totp-key-1", keyBase64url: "not-a-key" }],
    });
    await expect(loadIdentityTotpSecretProtector(invalid)).rejects.toThrow(
      "IDENTITY_SECRET_ENCODING_INVALID",
    );
  });
});

async function keyRingFile(mode: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await temporaryDirectory();
  const path = join(directory, "totp-key-ring.json");
  const value = {
    version: 1,
    currentKeyRevision: "totp-key-1",
    keys: [key("totp-key-1", 7)],
    ...overrides,
  };
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode });
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-totp-key-ring-"));
  temporaryDirectories.push(directory);
  return directory;
}

function key(keyRevision: string, fill: number) {
  return { keyRevision, keyBase64url: Buffer.alloc(32, fill).toString("base64url") };
}
