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

  it("keeps Commerce out of sibling infrastructure and every Credit-owned physical table", async () => {
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
      if (/platform\.credit_/u.test(source)) {
        violations.push(`${path}: accesses a Credit-owned table`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps Program catalog, revision, and window product truth out of Credit", async () => {
    const creditRoot = join(process.cwd(), "src", "modules", "credit");
    const violations: string[] = [];
    for (const file of await files(creditRoot)) {
      const path = relative(creditRoot, file);
      const source = await readFile(file, "utf8");
      if (/(?:credit|grant)-program/u.test(path) ||
          /platform\.(?:credit_program_catalog|credit_grant_program_revision|credit_program_window_acquisition)/u.test(source) ||
          /class CreditProgramCatalogService/u.test(source)) {
        violations.push(path);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the complete Program owner stack in Commerce", async () => {
    const commerceRoot = join(process.cwd(), "src", "modules", "commerce");
    const present = new Set((await files(commerceRoot)).map((file) => relative(commerceRoot, file)));
    expect([...present]).toEqual(expect.arrayContaining([
      "application/contracts/credit-program.ts",
      "application/contracts/credit-program-catalog.ts",
      "application/contracts/credit-program-catalog-reader.ts",
      "application/contracts/credit-program-administration-reader.ts",
      "application/credit-program-catalog-service.ts",
      "domain/credit-program-catalog.ts",
      "infrastructure/postgres/credit-program-repository.ts",
      "infrastructure/postgres/credit-program-catalog.ts",
      "infrastructure/postgres/credit-program-catalog-reader.ts",
      "infrastructure/postgres/credit-program-administration-reader.ts",
      "infrastructure/protobuf/credit-program-codec.ts",
    ]));
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
