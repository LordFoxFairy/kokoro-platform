import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Platform runtime contract ownership", () => {
  it("makes Credit and Model consume the root-generated platform-kit contract", async () => {
    const credit = await readFile(resolve("kokoro-credit/src/interfaces/http/schemas.ts"), "utf8");
    const model = await readFile(resolve("kokoro-model/src/interfaces/http/schemas.ts"), "utf8");
    expect(credit).toContain("@kokoro/platform-kit");
    expect(model).toContain("@kokoro/platform-kit");
    expect(credit).not.toMatch(/export const usageHoldRequestSchema\s*=\s*z/u);
    expect(credit).not.toMatch(/export const usageSettleRequestSchema\s*=\s*z/u);
    expect(credit).not.toMatch(/export const releaseCreditRequestSchema\s*=\s*z/u);
    expect(model).not.toMatch(/export const modelTransportKindSchema\s*=\s*z/u);
    expect(model).not.toMatch(/export const resolveModelBindingsQuerySchema\s*=\s*z/u);
    expect(model).not.toMatch(/export const listModelLabelsQuerySchema\s*=\s*z/u);
  });
});
