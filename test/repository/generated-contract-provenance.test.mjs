import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("checked-in canonical generated outputs match their Root provenance", () => {
  const result = spawnSync(process.execPath, [
    "scripts/contract/verify-generated-contracts.mjs",
    ".",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^generated_contracts_verified:[1-9][0-9]*\n$/u);
});
