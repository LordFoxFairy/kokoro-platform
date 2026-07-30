import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";
import {
  PLATFORM_ADMIN_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_ASSET_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_AUTHORIZATION_MAINTENANCE_DEPLOYMENT_CONTRACT,
  PLATFORM_COMMERCE_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_SITE_WORKER_DEPLOYMENT_CONTRACT,
  resolveProcessDeploymentEnvironment,
  type ProcessDeploymentContract,
} from "../../src/process/worker-deployment-contract.js";

interface DeploymentManifest {
  readonly deployables: readonly Readonly<{
    id: string;
    requiredEnvironment?: readonly string[];
    outboundContracts: readonly string[];
    secretClasses: readonly string[];
  }>[];
}

interface ComposeManifest {
  readonly services: Readonly<Record<string, Readonly<{
    environment: Readonly<Record<string, unknown>>;
    healthcheck?: Readonly<{ test?: readonly string[] }>;
  }>>>;
}

interface KubernetesResource {
  readonly kind: string;
  readonly metadata?: Readonly<{ name: string }>;
  readonly items?: readonly KubernetesResource[];
  readonly spec?: Readonly<{ template?: Readonly<{ spec?: Readonly<{
    terminationGracePeriodSeconds?: number;
    containers?: readonly Readonly<{
      name: string;
      startupProbe?: Readonly<{ httpGet?: Readonly<{ path?: string }> }>;
      livenessProbe?: Readonly<{ httpGet?: Readonly<{ path?: string }> }>;
      readinessProbe?: Readonly<{ httpGet?: Readonly<{ path?: string }> }>;
    }>[];
  }> }> }>;
}

describe("Platform worker deployment parity", () => {
  it("keeps machine-readable composition requirements aligned with deployables and Compose", async () => {
    const [deployables, compose] = await Promise.all([
      readFile("deployables.yaml", "utf8").then((value) => parse(value) as DeploymentManifest),
      readFile("deploy/docker-compose.services.yml", "utf8")
        .then((value) => parse(value) as ComposeManifest),
    ]);

    for (const contract of WORKER_CONTRACTS) assertParity(contract, deployables, compose);
  });

  it("fails closed when any declared required environment value is absent", () => {
    for (const contract of WORKER_CONTRACTS) {
      const complete = Object.fromEntries(
        contract.environment.required.map((name) => [name, `configured-${name}`]),
      );
      expect(resolveProcessDeploymentEnvironment(contract, complete)).toMatchObject(complete);
      for (const missing of contract.environment.required) {
        expect(() => resolveProcessDeploymentEnvironment(
          contract,
          Object.fromEntries(Object.entries(complete).filter(([name]) => name !== missing)),
        )).toThrow(`${missing}_REQUIRED`);
      }
    }
  });

  it("runs every owner worker independently and leaves worker.ts as lifecycle-only", async () => {
    const [entrypoint, lifecycleKernel, identityWorker, dockerfile, kubernetes] = await Promise.all([
      readFile("deploy/docker/runtime-entrypoint.mjs", "utf8"),
      readFile("src/process/worker.ts", "utf8"),
      readFile("src/process/identity-worker.ts", "utf8"),
      readFile("deploy/docker/Dockerfile", "utf8"),
      readFile("deploy/k8s/platform-services.example.yaml", "utf8"),
    ]);
    expect(entrypoint).toContain('"platform-identity-worker"');
    expect(entrypoint).toContain("identity-worker.js");
    expect(dockerfile).toContain("COPY --chown=node:node --from=build /app/dist ./dist");
    expect(identityWorker).toContain("createIdentityOutboxWorkerProductionComposition");
    expect(lifecycleKernel).not.toContain("ProductionComposition");
    expect(lifecycleKernel).not.toContain("runPlatformWorkerMain");
    for (const name of ["platform-commerce-worker", "platform-site-worker", "platform-asset-worker",
      "platform-admin-worker", "platform-identity-worker", "platform-authorization-maintenance"]) {
      expect(entrypoint).toContain(`"${name}"`);
    }
    const resources = parseAllDocuments(kubernetes)
      .map((document) => document.toJSON() as KubernetesResource)
      .flatMap((resource) => resource.kind === "List" ? resource.items ?? [] : [resource]);
    for (const name of ["platform-commerce-worker", "platform-site-worker", "platform-asset-worker",
      "platform-admin-worker", "platform-identity-worker"]) {
      const deployment = resources.find((resource) =>
        resource.kind === "Deployment" && resource.metadata?.name === name);
      expect(deployment, name).toBeDefined();
      expect(deployment?.spec?.template?.spec?.terminationGracePeriodSeconds).toBe(30);
      const container = deployment?.spec?.template?.spec?.containers?.find((value) =>
        value.name === name);
      expect(container?.startupProbe?.httpGet?.path).toBe("/health/live");
      expect(container?.livenessProbe?.httpGet?.path).toBe("/health/live");
      expect(container?.readinessProbe?.httpGet?.path).toBe("/health/ready");
    }
  });

  it("gives each worker an exact environment and a Compose readiness healthcheck", async () => {
    const [composeSource, kubernetes] = await Promise.all([
      readFile("deploy/docker-compose.services.yml", "utf8"),
      readFile("deploy/k8s/platform-services.example.yaml", "utf8"),
    ]);
    const compose = parse(composeSource) as ComposeManifest;
    for (const contract of POLLING_WORKER_CONTRACTS) {
      const service = compose.services[contract.id];
      expect(service?.healthcheck?.test?.join(" ")).toContain("/health/ready");
      const environmentNames = Object.keys(service?.environment ?? {});
      const requiredEnvironment = new Set<string>(contract.environment.required);
      const optionalEnvironment = new Set<string>(contract.environment.optional);
      expect(contract.environment.required.filter((name) => !environmentNames.includes(name)))
        .toEqual([]);
      expect(environmentNames.filter((name) =>
        name !== "KOKORO_SERVICE_PACKAGE" &&
        !requiredEnvironment.has(name) &&
        !optionalEnvironment.has(name))).toEqual([]);
    }
    const identityDeployment = kubernetes.slice(
      kubernetes.indexOf("metadata: { name: platform-identity-worker }"),
      kubernetes.indexOf("metadata: { name: platform-admin }"),
    );
    expect(identityDeployment).not.toContain("envFrom:");
    expect(identityDeployment).toContain("platform-identity-worker-database");
    expect(identityDeployment).toContain("identity-audit-digest-key");
    expect(identityDeployment).toContain("identity-delivery-hmac-key");
  });
});

const POLLING_WORKER_CONTRACTS = Object.freeze([
  PLATFORM_COMMERCE_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_SITE_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_ASSET_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_ADMIN_WORKER_DEPLOYMENT_CONTRACT,
  PLATFORM_IDENTITY_WORKER_DEPLOYMENT_CONTRACT,
] as const);

const WORKER_CONTRACTS = Object.freeze([
  ...POLLING_WORKER_CONTRACTS,
  PLATFORM_AUTHORIZATION_MAINTENANCE_DEPLOYMENT_CONTRACT,
] as const);

function assertParity(
  contract: ProcessDeploymentContract,
  manifest: DeploymentManifest,
  compose: ComposeManifest,
): void {
  const deployable = manifest.deployables.find((value) => value.id === contract.id);
  expect(deployable, contract.id).toBeDefined();
  expect(deployable?.requiredEnvironment).toEqual(contract.environment.required);
  expect(deployable?.outboundContracts).toEqual(contract.outboundContracts);
  expect(deployable?.secretClasses).toEqual(contract.secretClasses);
  const composeEnvironment = compose.services[contract.id]?.environment;
  expect(composeEnvironment, contract.id).toBeDefined();
  const names = new Set([
    ...Object.keys(composeEnvironment ?? {}),
    ...Object.keys((composeEnvironment?.["<<"] ?? {}) as Record<string, unknown>),
  ]);
  expect(contract.environment.required.filter((name) => !names.has(name))).toEqual([]);
}
