import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const businessModules = ["kokoro-site", "kokoro-user", "kokoro-model", "kokoro-credit", "kokoro-payment"];
const allowedTopLevelEntries = new Set([
  "application",
  "bootstrap",
  "config",
  "domain",
  "infrastructure",
  "interfaces",
  "index.ts",
  "module.ts",
]);

describe("platform module DDD layout", () => {
  it("keeps business modules on the four DDD layers", () => {
    for (const moduleName of businessModules) {
      const sourceEntries = readdirSync(join(process.cwd(), moduleName, "src"));
      const unexpectedEntries = sourceEntries.filter((entry) => !allowedTopLevelEntries.has(entry));

      expect(unexpectedEntries, `${moduleName} has non-DDD top-level entries`).toEqual([]);
    }
  });

  it("keeps admin adapters under interfaces and repository interfaces under domain", () => {
    for (const moduleName of businessModules) {
      const sourceRoot = join(process.cwd(), moduleName, "src");
      const interfaceEntries = readdirSync(join(sourceRoot, "interfaces"));
      const domainEntries = readdirSync(join(sourceRoot, "domain"));

      expect(interfaceEntries, `${moduleName} exposes admin through interfaces/admin`).toContain("admin");
      expect(domainEntries, `${moduleName} owns repository interfaces in domain`).toContain("repository.ts");
    }
  });
});
