import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
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

  it("keeps Commerce out of sibling infrastructure and Credit-owned mutations", async () => {
    const root = join(process.cwd(), "src");
    const commerceRoot = join(root, "modules", "commerce");
    const violations: string[] = [];
    for (const file of await files(commerceRoot)) {
      const source = await readFile(file, "utf8");
      const path = relative(root, file);
      for (const specifier of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
        const imported = specifier[1];
        if (imported === undefined || !imported.startsWith(".")) continue;
        const target = normalize(resolve(dirname(file), imported));
        if (target.includes(`${join("modules", "credit", "infrastructure")}${process.platform === "win32" ? "\\" : "/"}`)) {
          violations.push(`${path}: imports Credit infrastructure`);
        }
      }
      if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\.credit_/iu.test(source)) {
        violations.push(`${path}: mutates a Credit-owned table`);
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
