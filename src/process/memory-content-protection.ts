import { createMemoryContentProtector, parseMemoryContentKeyRing } from
  "../modules/memory/infrastructure/crypto/memory-content-protector.js";
import type { MemoryContentProtectionPort } from "../modules/memory/index.js";
import type { PlatformApiRuntimeFileReader } from "./platform-api-runtime-contract.js";

const MAXIMUM_KEY_RING_FILE_BYTES = 32 * 1024;

export async function loadPlatformApiMemoryContentProtector(
  reader: PlatformApiRuntimeFileReader,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<MemoryContentProtectionPort> {
  const path = environment.PLATFORM_MEMORY_CONTENT_KEY_RING_FILE;
  if (path === undefined || path.length < 1) {
    throw new Error("PLATFORM_MEMORY_CONTENT_KEY_RING_FILE_REQUIRED");
  }
  const source = await reader.read("PLATFORM_MEMORY_CONTENT_KEY_RING_FILE", path,
    MAXIMUM_KEY_RING_FILE_BYTES, "MEMORY_CONTENT_KEY_RING_FILE_INVALID");
  return createMemoryContentProtector(parseMemoryContentKeyRing(source));
}
