import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const selector = "platform-hub-connect";
const connectPort = 4252;
const healthPort = 4253;

const requiredRuntimeEnvironment = Object.freeze([
  "KOKORO_HUB_MONGO_URL",
  "KOKORO_HUB_MONGO_DB",
  "KOKORO_WORKSPACE_CONFIG",
  "KOKORO_WORKSPACE_S3_ACCESS_KEY",
  "KOKORO_WORKSPACE_S3_SECRET_KEY",
  "KOKORO_HUB_SECRET_MASTER_KEY",
  "KOKORO_HUB_CONNECT_TRUST_ROOT",
  "KOKORO_HUB_CONNECT_TLS_KEY_FILE",
  "KOKORO_HUB_CONNECT_TLS_CERT_FILE",
  "KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE",
  "KOKORO_HUB_CONNECT_MTLS_PEERS_FILE",
  "KOKORO_HUB_CATALOG_PLATFORM_CALLER_SAN_URI",
  "KOKORO_HUB_RUNTIME_AGENT_CALLER_SAN_URI",
  "KOKORO_HUB_CAPABILITY_SIGNING_KEY_REF",
  "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT",
  "KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_BASE_URL",
  "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_NAME",
  "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT",
  "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE",
  "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE",
]);

function environmentNames(container) {
  return new Set((container.env ?? []).map((entry) => entry.name));
}

test("the closed image selector starts the compiled Hub Connect main independently", async () => {
  const [entrypoint, imageVerifier] = await Promise.all([
    readFile(resolve(root, "deploy/docker/runtime-entrypoint.mjs"), "utf8"),
    readFile(resolve(root, "scripts/contract/verify-production-image.mjs"), "utf8"),
  ]);
  assert.match(
    entrypoint,
    /"platform-hub-connect":\s*\{\s*module:\s*"\.\.\/\.\.\/dist\/src\/process\/hub-connect\.js",\s*start:\s*"runHubConnectMain",?\s*\}/u,
  );
  assert.match(imageVerifier, /dist\/src\/process\/hub-connect\.js/u);
  assert.doesNotMatch(imageVerifier, /kokoro-hub\/dist\/interfaces\/connect\/main\.js/u);
});

test("deployable inventory declares the Hub Connect contract and dependency boundary", async () => {
  const document = parse(await readFile(resolve(root, "deployables.yaml"), "utf8"));
  const deployable = document.deployables.find((entry) => entry.id === selector);
  assert.deepEqual(deployable, {
    id: selector,
    command: "node --conditions=kokoro-runtime deploy/docker/runtime-entrypoint.mjs",
    selectorEnvironment: `KOKORO_SERVICE_PACKAGE=${selector}`,
    processRole: "hub-connect-runtime",
    inboundContracts: [],
    declaredInboundContracts: ["hub-runtime", "hub-capability-catalog"],
    outboundContracts: ["platform-capability-projection"],
    activationAuthorized: false,
    runtimeTraffic: true,
    secretClasses: [
      "hub-mongo",
      "hub-package-storage",
      "hub-secret-keyring",
      "capability-catalog-signing-key",
      "mtls-server",
      "mtls-peer-registry",
      "mtls-client",
      "platform-admission-peer-ca",
    ],
    audience: selector,
    scalingKey: "connect-request-concurrency",
    readiness: "/health/ready",
    drain: "http2-graceful",
    sloOwner: "platform-hub",
    runbookOwner: "platform-hub",
    releaseOwner: "platform",
  });
});

test("Compose keeps Hub HTTP and Hub Connect in separate processes with complete production wiring", async () => {
  const document = parse(
    await readFile(resolve(root, "deploy/docker-compose.services.yml"), "utf8"),
  );
  const http = document.services["kokoro-hub"];
  const connect = document.services[selector];
  assert.ok(http && connect);
  assert.equal(http.environment.KOKORO_SERVICE_PACKAGE, "@kokoro/hub");
  assert.equal(connect.environment.KOKORO_SERVICE_PACKAGE, selector);
  assert.equal(connect.environment.KOKORO_HUB_CONNECT_PORT, connectPort);
  assert.equal(connect.environment.KOKORO_HUB_CONNECT_HEALTH_PORT, healthPort);
  assert.deepEqual(connect.ports, [`${connectPort}:${connectPort}`]);
  assert.ok(connect.healthcheck.test.join(" ").includes(`/health/ready`));
  assert.ok(connect.healthcheck.test.join(" ").includes(String(healthPort)));
  for (const name of requiredRuntimeEnvironment) {
    assert.ok(Object.hasOwn(connect.environment, name), `Compose missing ${name}`);
  }
  assert.equal(connect.environment.KOKORO_HUB_CONNECT_TRUST_ROOT,
    "/run/secrets/hub-connect-inbound");
  assert.equal(connect.environment.KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT,
    "/run/secrets/hub-capability-signing");
  assert.equal(connect.environment.KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT,
    "/run/secrets/hub-platform-projection");
  assert.deepEqual(connect.volumes.slice(0, 3), [{
    type: "bind",
    source: "${KOKORO_HUB_CONNECT_INBOUND_SECRETS_DIRECTORY:?required}",
    target: "/run/secrets/hub-connect-inbound",
    read_only: true,
  }, {
    type: "bind",
    source: "${KOKORO_HUB_CAPABILITY_SIGNING_SECRETS_DIRECTORY:?required}",
    target: "/run/secrets/hub-capability-signing",
    read_only: true,
  }, {
    type: "bind",
    source: "${KOKORO_HUB_PLATFORM_PROJECTION_SECRETS_DIRECTORY:?required}",
    target: "/run/secrets/hub-platform-projection",
    read_only: true,
  }]);
  assert.deepEqual(connect.depends_on, {
    "platform-admission": { condition: "service_started" },
  });
  assert.notEqual(http.environment.KOKORO_HUB_PORT, connect.environment.KOKORO_HUB_CONNECT_PORT);
  assert.notEqual(
    connect.environment.KOKORO_HUB_CONNECT_PORT,
    connect.environment.KOKORO_HUB_CONNECT_HEALTH_PORT,
  );
});

test("Kubernetes publishes only Hub Connect traffic and probes dependency-aware health separately", async () => {
  const document = parse(
    await readFile(resolve(root, "deploy/k8s/platform-services.example.yaml"), "utf8"),
  );
  const deployment = document.items.find(
    (entry) => entry.kind === "Deployment" && entry.metadata?.name === selector,
  );
  const service = document.items.find(
    (entry) => entry.kind === "Service" && entry.metadata?.name === selector,
  );
  const serviceAccount = document.items.find(
    (entry) => entry.kind === "ServiceAccount" && entry.metadata?.name === selector,
  );
  assert.ok(deployment && service && serviceAccount);
  assert.equal(serviceAccount.automountServiceAccountToken, false);
  const pod = deployment.spec.template.spec;
  const container = pod.containers.find((entry) => entry.name === selector);
  assert.ok(container);
  assert.equal(pod.serviceAccountName, selector);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(container.ports, [
    { name: "connect", containerPort: connectPort },
    { name: "health", containerPort: healthPort },
  ]);
  assert.deepEqual(container.livenessProbe.httpGet, {
    path: "/health/live",
    port: "health",
    scheme: "HTTP",
  });
  assert.deepEqual(container.readinessProbe.httpGet, {
    path: "/health/ready",
    port: "health",
    scheme: "HTTP",
  });
  const names = environmentNames(container);
  for (const name of [
    "KOKORO_SERVICE_PACKAGE",
    "KOKORO_HUB_CONNECT_PORT",
    "KOKORO_HUB_CONNECT_HEALTH_PORT",
    "KOKORO_WORKSPACE_CONFIG",
    "KOKORO_HUB_CONNECT_TRUST_ROOT",
    "KOKORO_HUB_CONNECT_TLS_KEY_FILE",
    "KOKORO_HUB_CONNECT_TLS_CERT_FILE",
    "KOKORO_HUB_CONNECT_TLS_CLIENT_CA_FILE",
    "KOKORO_HUB_CONNECT_MTLS_PEERS_FILE",
    "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT",
    "KOKORO_HUB_CAPABILITY_SIGNING_KEY_FILE",
    "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT",
    "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_KEY_FILE",
    "KOKORO_HUB_PLATFORM_PROJECTION_CLIENT_CERT_FILE",
    "KOKORO_HUB_PLATFORM_PROJECTION_SERVER_CA_FILE",
  ])
    assert.ok(names.has(name), `Kubernetes missing ${name}`);
  assert.deepEqual(container.envFrom, [
    { configMapRef: { name: "platform-hub-connect-runtime" } },
    { secretRef: { name: "platform-hub-connect-secrets" } },
  ]);
  const expectedSecretMounts = Object.freeze({
    "hub-connect-inbound": "/run/secrets/hub-connect-inbound",
    "hub-capability-signing": "/run/secrets/hub-capability-signing",
    "hub-platform-projection": "/run/secrets/hub-platform-projection",
  });
  for (const [name, mountPath] of Object.entries(expectedSecretMounts)) {
    assert.deepEqual(container.volumeMounts.find((entry) => entry.name === name), {
      name, mountPath, readOnly: true,
    });
    const secretVolume = pod.volumes.find((entry) => entry.name === name);
    assert.equal(secretVolume.secret.defaultMode, 256);
  }
  assert.equal(container.env.find((entry) => entry.name === "KOKORO_HUB_CONNECT_TRUST_ROOT").value,
    expectedSecretMounts["hub-connect-inbound"]);
  assert.equal(container.env.find(
    (entry) => entry.name === "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT").value,
  expectedSecretMounts["hub-capability-signing"]);
  assert.equal(container.env.find(
    (entry) => entry.name === "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT").value,
  expectedSecretMounts["hub-platform-projection"]);
  assert.ok(
    container.volumeMounts.some(
      (entry) => entry.name === "hub-storage-config" && entry.readOnly === true,
    ),
  );
  assert.deepEqual(service.spec.ports, [
    { name: "connect", port: connectPort, targetPort: "connect" },
  ]);
  assert.deepEqual(service.spec.selector, { app: selector });
  assert.equal(
    service.spec.ports.some((entry) => entry.port === healthPort),
    false,
  );

  const httpDeployment = document.items.find(
    (entry) => entry.kind === "Deployment" && entry.metadata?.name === "kokoro-hub",
  );
  const httpContainer = httpDeployment.spec.template.spec.containers[0];
  assert.equal(environmentNames(httpContainer).has("KOKORO_HUB_CONNECT_PORT"), false);
  assert.equal(environmentNames(container).has("KOKORO_HUB_PORT"), false);
});

test("operator examples document the three non-overlapping Hub trust roots", async () => {
  const [example, topology] = await Promise.all([
    readFile(resolve(root, ".env.example"), "utf8"),
    readFile(resolve(root, "docs/platform/deployment-topology.md"), "utf8"),
  ]);
  for (const name of [
    "KOKORO_HUB_CONNECT_INBOUND_SECRETS_DIRECTORY",
    "KOKORO_HUB_CAPABILITY_SIGNING_SECRETS_DIRECTORY",
    "KOKORO_HUB_PLATFORM_PROJECTION_SECRETS_DIRECTORY",
    "KOKORO_HUB_CONNECT_TRUST_ROOT",
    "KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT",
    "KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT",
  ]) {
    assert.match(example, new RegExp(`^${name}=`, "mu"), `.env.example missing ${name}`);
    assert.ok(topology.includes(`\`${name}\``), `topology missing ${name}`);
  }
  assert.match(topology, /three independent read-only secret mounts/u);
});
