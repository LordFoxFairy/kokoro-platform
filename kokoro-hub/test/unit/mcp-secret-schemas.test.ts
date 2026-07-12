import { describe, expect, it } from "vitest";
import { generateSecretHandle } from "../../src/domain/secret-handle.js";
import {
  createSecretBodySchema,
  resolveSecretsBodySchema,
  secretHandleParamsSchema,
} from "../../src/interfaces/http/mcp-secret-schemas.js";

describe("createSecretBodySchema", () => {
  it("accepts a well-formed create body", () => {
    const parsed = createSecretBodySchema.parse({ name: "github-token", value: "example-token" });
    expect(parsed).toEqual({ name: "github-token", value: "example-token" });
  });

  it("rejects empty name/value, oversize value, extra fields, and a scope leak", () => {
    expect(createSecretBodySchema.safeParse({ name: "", value: "v" }).success).toBe(false);
    expect(createSecretBodySchema.safeParse({ name: "n", value: "" }).success).toBe(false);
    expect(createSecretBodySchema.safeParse({ name: "n", value: "x".repeat(8 * 1024 + 1) }).success).toBe(false);
    // strict：scope/namespace 不得进 body（防信封外伪造 scope）。
    expect(createSecretBodySchema.safeParse({ name: "n", value: "v", scope: "ns-x" }).success).toBe(false);
    expect(createSecretBodySchema.safeParse({ name: "n" }).success).toBe(false);
  });
});

describe("secretHandleParamsSchema", () => {
  it("accepts an srt_ handle and rejects malformed handles", () => {
    expect(secretHandleParamsSchema.safeParse({ handle: generateSecretHandle() }).success).toBe(true);
    for (const handle of ["srt_short", "not-a-handle", `srt_${"A".repeat(32)}`, ""]) {
      expect(secretHandleParamsSchema.safeParse({ handle }).success, `'${handle}'`).toBe(false);
    }
  });
});

describe("resolveSecretsBodySchema", () => {
  const handles = [generateSecretHandle(), generateSecretHandle()];

  it("accepts a namespace + handle batch", () => {
    const parsed = resolveSecretsBodySchema.parse({ namespace: "ns-a", handles });
    expect(parsed.handles).toEqual(handles);
  });

  it("rejects empty handles, bad handle shapes, oversize batches, and missing namespace", () => {
    expect(resolveSecretsBodySchema.safeParse({ namespace: "ns-a", handles: [] }).success).toBe(false);
    expect(resolveSecretsBodySchema.safeParse({ namespace: "ns-a", handles: ["bad"] }).success).toBe(false);
    expect(
      resolveSecretsBodySchema.safeParse({
        namespace: "ns-a",
        handles: Array.from({ length: 101 }, () => generateSecretHandle()),
      }).success,
    ).toBe(false);
    expect(resolveSecretsBodySchema.safeParse({ handles }).success).toBe(false);
    expect(resolveSecretsBodySchema.safeParse({ namespace: "ns-a", handles, extra: 1 }).success).toBe(false);
  });
});
