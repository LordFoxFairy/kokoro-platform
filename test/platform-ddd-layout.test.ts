import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const platformModules = [
  "admin",
  "admin-control",
  "admission",
  "asset",
  "authorization",
  "commerce",
  "credit",
  "identity",
  "media",
  "model-control",
  "model-gateway",
  "policy",
  "site",
];
const allowedModuleEntries = new Set([
  "INDEX.md",
  "application",
  "domain",
  "index.ts",
  "infrastructure",
  "interfaces",
  "migration",
]);

describe("fresh Platform module topology", () => {
  it("owns every business capability under the root module tree", () => {
    const actual = readdirSync(join(process.cwd(), "src/modules"))
      .filter((entry) => statSync(join(process.cwd(), "src/modules", entry)).isDirectory())
      .sort();
    expect(actual).toEqual(platformModules);
  });

  it("keeps module code inside explicit DDD and migration boundaries", () => {
    for (const moduleName of platformModules) {
      const entries = readdirSync(join(process.cwd(), "src/modules", moduleName));
      const unexpected = entries.filter((entry) => !allowedModuleEntries.has(entry));
      expect(unexpected, `${moduleName} has an unowned top-level surface`).toEqual([]);
      expect(entries).toContain("application");
    }
  });
});
