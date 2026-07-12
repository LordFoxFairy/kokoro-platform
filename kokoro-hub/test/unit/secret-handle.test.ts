import { describe, expect, it } from "vitest";
import { SECRET_HANDLE_RE } from "../../src/contract/mcp-secret-storage.js";
import { generateSecretHandle, isSecretHandle } from "../../src/domain/secret-handle.js";

describe("secret handle", () => {
  it("generates srt_ + 32 hex opaque handles", () => {
    const handle = generateSecretHandle();
    expect(handle).toMatch(SECRET_HANDLE_RE);
    expect(handle.startsWith("srt_")).toBe(true);
  });

  it("generates collision-free handles across many draws", () => {
    const handles = new Set(Array.from({ length: 1000 }, () => generateSecretHandle()));
    expect(handles.size).toBe(1000);
  });

  it("isSecretHandle rejects non-handle shapes", () => {
    expect(isSecretHandle(generateSecretHandle())).toBe(true);
    for (const bad of ["srt_", "srt_XYZ", "handle:srt_" + "a".repeat(32), "srt_" + "a".repeat(31), "srt_" + "A".repeat(32), ""]) {
      expect(isSecretHandle(bad), `'${bad}' must be rejected`).toBe(false);
    }
  });
});
