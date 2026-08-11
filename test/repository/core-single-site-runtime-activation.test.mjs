import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

test("inventory authorizes only the fixed single-Site core runtimes plus the existing artifact plane", async () => {
  const document = parse(await readFile(resolve(root, "deployables.yaml"), "utf8"));
  const states = Object.fromEntries(document.deployables.map((deployable) => [
    deployable.id,
    [deployable.activationAuthorized, deployable.runtimeTraffic],
  ]));

  assert.deepEqual(states, {
    "platform-api": [true, true],
    "platform-admission": [true, true],
    "platform-commerce-worker": [false, false],
    "platform-site-worker": [false, false],
    "platform-asset-worker": [false, false],
    "platform-admin-worker": [false, false],
    "platform-authorization-maintenance": [false, false],
    "platform-identity-worker": [false, false],
    "platform-media-worker": [false, false],
    "platform-model-gateway": [true, true],
    "platform-model-image-worker": [false, false],
    "platform-authorization": [true, true],
    "platform-asset-data-plane": [false, false],
    "platform-artifact-data-plane": [true, true],
    "platform-admin": [false, false],
    "platform-hub-connect": [true, true],
    "platform-core-bootstrap": [false, false],
    "platform-migrator": [false, false],
    "platform-admin-authority-bootstrap": [false, false],
  });
});
