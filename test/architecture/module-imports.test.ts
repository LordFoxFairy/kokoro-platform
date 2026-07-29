import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

describe("Platform module boundaries", () => {
  it("keeps ORM handles in the PostgreSQL infrastructure boundary", async () => {
    const root = join(process.cwd(), "src");
    const violations: string[] = [];
    for (const file of await files(root)) {
      const source = await readFile(file, "utf8");
      const path = relative(root, file);
      if (/Prisma(?:Client|\.TransactionClient)|@prisma\//u.test(source) && !path.startsWith("infrastructure/postgres/")) {
        violations.push(path);
      }
      if (/src\/modules\/[^/]+\/infrastructure/u.test(source) && path.includes("modules/")) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });
});

async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (extname(path) === ".ts" && !path.includes("/generated/")) result.push(path);
  }
  return result;
}
