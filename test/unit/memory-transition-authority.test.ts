import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMemoryTransitionAuthority } from "../../src/modules/memory/index.js";

describe("Memory transition authority", () => {
  it("issues a domain-separated HMAC receipt without exposing mutable key bytes", async () => {
    const key = new Uint8Array(32).fill(7);
    const authority = createMemoryTransitionAuthority({ keyRevision: "memory-transition-r1", key });
    key.fill(0);
    const canonicalPayload = "{\"command\":{\"operation\":\"remember\"}}";
    const receipt = await authority.issue({ canonicalPayload });
    expect(receipt).toEqual({ keyRevision: "memory-transition-r1",
      digest: createHmac("sha256", new Uint8Array(32).fill(7))
        .update("kokoro.memory.transition.v1\0", "utf8")
        .update(canonicalPayload, "utf8").digest("hex") });
  });

  it("rejects malformed key material and oversized authority payloads", async () => {
    expect(() => createMemoryTransitionAuthority({ keyRevision: "bad space",
      key: new Uint8Array(32) })).toThrow();
    const authority = createMemoryTransitionAuthority({ keyRevision: "memory-transition-r1",
      key: new Uint8Array(32).fill(1) });
    await expect(authority.issue({ canonicalPayload: "x".repeat(131_073) })).rejects.toThrow();
  });
});
