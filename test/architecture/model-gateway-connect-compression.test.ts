import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Model Gateway Connect compression compatibility", () => {
  it("accepts the Agent client's bounded gzip negotiation only", async () => {
    const composition = await readFile("src/process/model-gateway-composition.ts", "utf8");

    expect(composition).toMatch(/import\s*\{[^}]*compressionGzip[^}]*\}\s*from\s*"@connectrpc\/connect-node"/su);
    expect(composition).toMatch(/acceptCompression:\s*\[compressionGzip\]/u);
    expect(composition).not.toMatch(/compressionBrotli/u);
  });
});
