import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const keyRingEnvironment = "PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE";
const keyRingPath = "/run/secrets/platform-admin/commerce-redemption-keys.json";

test("AdminCommerce keeps its required redemption key ring closed across deployment manifests", async () => {
  const [deployables, compose, kubernetes] = await Promise.all([
    readFile(resolve(root, "deployables.yaml"), "utf8").then(parse),
    readFile(resolve(root, "deploy/docker-compose.services.yml"), "utf8").then(parse),
    readFile(resolve(root, "deploy/k8s/platform-services.example.yaml"), "utf8").then(parse),
  ]);

  const deployable = deployables.deployables.find((candidate) => candidate.id === "platform-admin");
  assert.ok(deployable);
  assert.ok(deployable.secretClasses.includes("commerce-redemption-keyring"));

  const composeAdmin = compose.services["platform-admin"];
  assert.ok(composeAdmin);
  assert.equal(composeAdmin.environment[keyRingEnvironment], keyRingPath);
  assert.deepEqual(composeAdmin.volumes.find((volume) => volume.target === keyRingPath), {
    type: "bind",
    source: "${PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE:?required}",
    target: keyRingPath,
    read_only: true,
  });

  const adminDeployment = kubernetes.items.find((item) =>
    item.kind === "Deployment" && item.metadata?.name === "platform-admin");
  assert.ok(adminDeployment);
  const pod = adminDeployment.spec.template.spec;
  const container = pod.containers.find((candidate) => candidate.name === "platform-admin");
  assert.ok(container);
  assert.equal(container.env.find((entry) => entry.name === keyRingEnvironment)?.value, keyRingPath);
  assert.deepEqual(container.volumeMounts.find((mount) =>
    mount.name === "commerce-redemption-keyring"), {
    name: "commerce-redemption-keyring",
    mountPath: "/run/secrets/platform-admin",
    readOnly: true,
  });
  assert.deepEqual(pod.volumes.find((volume) => volume.name === "commerce-redemption-keyring"), {
    name: "commerce-redemption-keyring",
    secret: {
      secretName: "commerce-redemption-keyring",
      defaultMode: 288,
      items: [{
        key: "commerce-redemption-keys.json",
        path: "commerce-redemption-keys.json",
      }],
    },
  });
});
