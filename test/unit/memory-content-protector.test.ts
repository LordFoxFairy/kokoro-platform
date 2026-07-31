import { describe, expect, it } from "vitest";
import {
  createMemoryContentProtector,
  parseMemoryContentKeyRing,
} from "../../src/modules/memory/infrastructure/crypto/memory-content-protector.js";
import {
  createProtectedMemoryContent,
  memoryEntryRef,
  memoryRevisionRef,
  memorySiteRef,
  memorySpaceRef,
} from "../../src/modules/memory/index.js";
import { PLATFORM_API_RUNTIME_CONTRACT, type PlatformApiRuntimeFileReader } from
  "../../src/process/platform-api-runtime-contract.js";
import { loadPlatformApiMemoryContentProtector } from
  "../../src/process/memory-content-protection.js";

const binding = Object.freeze({
  siteRef: memorySiteRef("site-alpha"),
  spaceRef: memorySpaceRef("space-alpha"),
  entryRef: memoryEntryRef("entry-alpha"),
  revisionRef: memoryRevisionRef("revision-alpha"),
});

describe("Memory content protector", () => {
  it("protects one copied payload with the exact AES-256-GCM envelope", async () => {
    const activeKey = key("memory-key-r2", "active", 2);
    const protector = createMemoryContentProtector(keyRing("memory-key-r2", [
      key("memory-key-r1", "decrypt_only", 1), activeKey,
    ]));
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const protectedContent = await protector.protect({ binding, plaintext });
    plaintext[0] = 99;
    activeKey.key.fill(99);

    expect(protectedContent.envelopeVersion).toBe(1);
    expect(protectedContent.keyRevision).toBe("memory-key-r2");
    expect(protectedContent.aadDigest)
      .toBe("86fc4a2e07457886f2aa35c10bebbbdf99113a9def8cec4208dbbfb60237869e");
    expect(protectedContent.copyNonce()).toHaveLength(12);
    expect(protectedContent.copyAuthenticationTag()).toHaveLength(16);
    expect(protectedContent.copyCiphertext()).toHaveLength(4);
    expect([...await protector.reveal({ binding, protectedContent })]).toEqual([1, 2, 3, 4]);

    const ciphertext = protectedContent.copyCiphertext();
    ciphertext[0] = 88;
    const nonce = protectedContent.copyNonce();
    nonce[0] = 77;
    const authenticationTag = protectedContent.copyAuthenticationTag();
    authenticationTag[0] = 66;
    expect(protectedContent.copyCiphertext()[0]).not.toBe(88);
    expect(protectedContent.copyNonce()[0]).not.toBe(77);
    expect(protectedContent.copyAuthenticationTag()[0]).not.toBe(66);
    const revealed = await protector.reveal({ binding, protectedContent });
    revealed[0] = 66;
    expect([...await protector.reveal({ binding, protectedContent })]).toEqual([1, 2, 3, 4]);
  });

  it("rejects AAD mismatch independently on every owner axis before decrypting", async () => {
    const protector = createMemoryContentProtector(keyRing("memory-key-r1", [
      key("memory-key-r1", "active", 1),
    ]));
    const protectedContent = await protector.protect({ binding, plaintext: new Uint8Array([7]) });
    for (const mismatched of [
      { ...binding, siteRef: memorySiteRef("site-beta") },
      { ...binding, spaceRef: memorySpaceRef("space-beta") },
      { ...binding, entryRef: memoryEntryRef("entry-beta") },
      { ...binding, revisionRef: memoryRevisionRef("revision-beta") },
    ]) {
      await expect(protector.reveal({ binding: mismatched, protectedContent }))
        .rejects.toThrow("MEMORY_CONTENT_AAD_MISMATCH");
    }
  });

  it("supports decrypt-only rotation and distinguishes retired from unknown keys", async () => {
    const original = createMemoryContentProtector(keyRing("memory-key-r1", [
      key("memory-key-r1", "active", 1),
    ]));
    const protectedContent = await original.protect({ binding, plaintext: new Uint8Array([4, 2]) });
    const rotated = createMemoryContentProtector(keyRing("memory-key-r2", [
      key("memory-key-r1", "decrypt_only", 1), key("memory-key-r2", "active", 2),
    ]));
    await expect(rotated.reveal({ binding, protectedContent }))
      .resolves.toEqual(new Uint8Array([4, 2]));

    const retired = createMemoryContentProtector({ ...keyRing("memory-key-r2", [
      key("memory-key-r2", "active", 2),
    ]), retiredKeyRevisions: ["memory-key-r1"] });
    await expect(retired.reveal({ binding, protectedContent }))
      .rejects.toThrow("MEMORY_CONTENT_KEY_RETIRED");
    const unknown = createMemoryContentProtector(keyRing("memory-key-r2", [
      key("memory-key-r2", "active", 2),
    ]));
    await expect(unknown.reveal({ binding, protectedContent }))
      .rejects.toThrow("MEMORY_CONTENT_KEY_REVISION_UNKNOWN");
  });

  it("fails closed on malformed rings, bounds, envelope tampering and plaintext-safe errors", async () => {
    expect(() => createMemoryContentProtector(keyRing("memory-key-r1", [
      { ...key("memory-key-r1", "active", 1), key: new Uint8Array(31) },
    ]))).toThrow("MEMORY_CONTENT_KEY_RING_INVALID");
    expect(() => createMemoryContentProtector(keyRing("memory-key-r1", [
      key("memory-key-r1", "active", 1), key("memory-key-r1", "decrypt_only", 2),
    ]))).toThrow("MEMORY_CONTENT_KEY_RING_INVALID");
    expect(() => createMemoryContentProtector(keyRing("memory-key-r1", [
      key("memory-key-r1", "active", 1), key("memory-key-r2", "decrypt_only", 1),
    ]))).toThrow("MEMORY_CONTENT_KEY_RING_INVALID");

    const protector = createMemoryContentProtector(keyRing("memory-key-r1", [
      key("memory-key-r1", "active", 1),
    ]));
    await expect(protector.protect({ binding, plaintext: new Uint8Array() }))
      .rejects.toThrow("MEMORY_CONTENT_PLAINTEXT_INVALID");
    await expect(protector.protect({ binding, plaintext: new Uint8Array(16_385) }))
      .rejects.toThrow("MEMORY_CONTENT_PLAINTEXT_INVALID");

    const secret = new TextEncoder().encode("do-not-leak-memory-plaintext");
    const protectedContent = await protector.protect({ binding, plaintext: secret });
    const tamperedBytes = protectedContent.copyCiphertext();
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 1;
    const tampered = createProtectedMemoryContent({
      envelopeVersion: protectedContent.envelopeVersion,
      keyRevision: protectedContent.keyRevision,
      nonce: protectedContent.copyNonce(),
      ciphertext: tamperedBytes,
      authenticationTag: protectedContent.copyAuthenticationTag(),
      aadDigest: protectedContent.aadDigest,
    });
    const error = await protector.reveal({ binding, protectedContent: tampered })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "MEMORY_CONTENT_DECRYPTION_FAILED" });
    expect(JSON.stringify(error)).not.toContain("do-not-leak-memory-plaintext");
    expect(String(error)).not.toContain("do-not-leak-memory-plaintext");
  });

  it("parses only canonical bounded key-ring JSON", () => {
    const raw = JSON.stringify({
      version: 1,
      activeKeyRevision: "memory-key-r1",
      keys: [{ keyRevision: "memory-key-r1", status: "active",
        keyBase64url: Buffer.alloc(32, 1).toString("base64url") }],
      retiredKeyRevisions: [],
    });
    expect(parseMemoryContentKeyRing(raw)).toMatchObject({
      version: 1, activeKeyRevision: "memory-key-r1", retiredKeyRevisions: [],
    });
    expect(() => parseMemoryContentKeyRing(JSON.stringify({ ...JSON.parse(raw), extra: true })))
      .toThrow("MEMORY_CONTENT_KEY_RING_INVALID");
    expect(() => parseMemoryContentKeyRing(raw.replace(
      Buffer.alloc(32, 1).toString("base64url"), "non-canonical")))
      .toThrow("MEMORY_CONTENT_KEY_RING_INVALID");
  });

  it("requires the private Platform API file contract and has no default production key", async () => {
    expect(PLATFORM_API_RUNTIME_CONTRACT.uncomposedFiles).toContainEqual({
      environment: "PLATFORM_MEMORY_CONTENT_KEY_RING_FILE",
      filename: "memory-content-keys.json",
      privateMaterial: true,
      secretClass: "memory-content-encryption-keyring",
    });
    const calls: unknown[][] = [];
    const read: PlatformApiRuntimeFileReader["read"] = async (
      environment, path, maximumBytes, invalidCode,
    ) => {
      calls.push([environment, path, maximumBytes, invalidCode]);
      return JSON.stringify({
        version: 1,
        activeKeyRevision: "memory-key-r1",
        keys: [{ keyRevision: "memory-key-r1", status: "active",
          keyBase64url: Buffer.alloc(32, 1).toString("base64url") }],
        retiredKeyRevisions: [],
      });
    };
    const reader: PlatformApiRuntimeFileReader = Object.freeze({
      read,
    });
    await expect(loadPlatformApiMemoryContentProtector(reader, {}))
      .rejects.toThrow("PLATFORM_MEMORY_CONTENT_KEY_RING_FILE_REQUIRED");
    const protector = await loadPlatformApiMemoryContentProtector(reader, {
      PLATFORM_MEMORY_CONTENT_KEY_RING_FILE: "/run/secrets/platform-api/memory-content-keys.json",
    });
    expect(calls).toEqual([[
      "PLATFORM_MEMORY_CONTENT_KEY_RING_FILE",
      "/run/secrets/platform-api/memory-content-keys.json",
      32 * 1024,
      "MEMORY_CONTENT_KEY_RING_FILE_INVALID",
    ]]);
    await expect(protector.protect({ binding, plaintext: new Uint8Array([1]) })).resolves.toBeTruthy();
  });
});

function key(keyRevision: string, status: "active" | "decrypt_only", fill: number) {
  return Object.freeze({ keyRevision, status, key: new Uint8Array(32).fill(fill) });
}

function keyRing(activeKeyRevision: string, keys: readonly ReturnType<typeof key>[]) {
  return Object.freeze({ version: 1 as const, activeKeyRevision, keys,
    retiredKeyRevisions: Object.freeze([] as string[]) });
}
