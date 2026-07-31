import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedFileReaderWithinTrustRoot } from "../../src/process/secret-files.js";
import { createPlatformApiRuntimeFileReader } from
  "../../src/process/platform-api-runtime-contract.js";
import { loadPlatformApiMemoryContentProtector } from
  "../../src/process/memory-content-protection.js";
import { memoryEntryRef, memoryRevisionRef, memorySiteRef, memorySpaceRef } from
  "../../src/modules/memory/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0)
    .map((path) => rm(path, { recursive: true, force: true })));
});

describe("Memory content key-ring startup configuration", () => {
  it("loads only a bounded owner-private file inside the Platform API trust root", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "memory-content-keys.json");
    await writeFile(path, keyRingJson(), { encoding: "utf8", mode: 0o600 });
    const trusted = await createBoundedFileReaderWithinTrustRoot(
      directory, "PLATFORM_API_FILE_TRUST_ROOT_INVALID",
    );
    const reader = createPlatformApiRuntimeFileReader(trusted);
    const protector = await loadPlatformApiMemoryContentProtector(reader, {
      PLATFORM_MEMORY_CONTENT_KEY_RING_FILE: path,
    });
    const binding = { siteRef: memorySiteRef("site-one"), spaceRef: memorySpaceRef("space-one"),
      entryRef: memoryEntryRef("entry-one"), revisionRef: memoryRevisionRef("revision-one") };
    const envelope = await protector.protect({ binding, plaintext: new Uint8Array([1, 2]) });
    await expect(protector.reveal({ binding, protectedContent: envelope }))
      .resolves.toEqual(new Uint8Array([1, 2]));

    await chmod(path, 0o644);
    await expect(loadPlatformApiMemoryContentProtector(reader, {
      PLATFORM_MEMORY_CONTENT_KEY_RING_FILE: path,
    })).rejects.toThrow("MEMORY_CONTENT_KEY_RING_FILE_INVALID");
  });

  it("rejects a key-ring path outside the stable trust root", async () => {
    const trustedDirectory = await temporaryDirectory();
    const outsideDirectory = await temporaryDirectory();
    const outside = join(outsideDirectory, "memory-content-keys.json");
    await writeFile(outside, keyRingJson(), { encoding: "utf8", mode: 0o600 });
    const reader = createPlatformApiRuntimeFileReader(
      await createBoundedFileReaderWithinTrustRoot(
        trustedDirectory, "PLATFORM_API_FILE_TRUST_ROOT_INVALID",
      ),
    );
    await expect(loadPlatformApiMemoryContentProtector(reader, {
      PLATFORM_MEMORY_CONTENT_KEY_RING_FILE: outside,
    })).rejects.toThrow("MEMORY_CONTENT_KEY_RING_FILE_INVALID");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-memory-key-ring-"));
  temporaryDirectories.push(directory);
  return directory;
}

function keyRingJson(): string {
  return JSON.stringify({ version: 1, activeKeyRevision: "memory-key-r1",
    keys: [{ keyRevision: "memory-key-r1", status: "active",
      keyBase64url: Buffer.alloc(32, 1).toString("base64url") }],
    retiredKeyRevisions: [] });
}
