import { describe, expect, it } from "vitest";
import { modelStreamFrameDigest } from
  "../../src/interfaces/connect/generated-model-gateway/model-stream-frame-digest.js";

describe("model stream frame digest contract", () => {
  it("binds identity, sequence, previous digest, payload kind and bytes", () => {
    const base = {
      invocationRef: "invocation-1",
      attemptRef: "attempt-1",
      sequence: 2n,
      previousFrameDigest: "a".repeat(64),
      payloadKind: "content_delta" as const,
      payloadBytes: new TextEncoder().encode('{"content":"hello","kind":"content_delta"}'),
    };
    const digest = modelStreamFrameDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(modelStreamFrameDigest(base)).toBe(digest);
    expect(modelStreamFrameDigest({ ...base, sequence: 3n })).not.toBe(digest);
    expect(modelStreamFrameDigest({ ...base, attemptRef: "attempt-2" })).not.toBe(digest);
    expect(modelStreamFrameDigest({ ...base, previousFrameDigest: "b".repeat(64) })).not.toBe(digest);
  });
});
