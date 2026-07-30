import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PLATFORM_API_RUNTIME_CONTRACT } from "../../src/process/platform-api-runtime-contract.js";

type UnknownRecord = Record<string, unknown>;

const root = resolve(import.meta.dirname, "../..");
const target = (filename: string) => `${PLATFORM_API_RUNTIME_CONTRACT.trustRootPath}/${filename}`;

function record(value: unknown): UnknownRecord {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as UnknownRecord;
}

function records(value: unknown): UnknownRecord[] {
  expect(Array.isArray(value)).toBe(true);
  return value as UnknownRecord[];
}

function named(items: unknown, kind: string, name: string): UnknownRecord {
  const item = records(items).find((candidate) =>
    candidate.kind === kind && record(candidate.metadata).name === name);
  expect(item, `${kind}/${name}`).toBeDefined();
  return item!;
}

describe("Platform API production deployable parity", () => {
  it("keeps composition, deployables, Compose, and Kubernetes on one exact file contract", async () => {
    const [deployableDocument, composeDocument, kubernetesDocument] = await Promise.all([
      readFile(resolve(root, "deployables.yaml"), "utf8").then((value) => parse(value) as UnknownRecord),
      readFile(resolve(root, "deploy/docker-compose.services.yml"), "utf8")
        .then((value) => parse(value) as UnknownRecord),
      readFile(resolve(root, "deploy/k8s/platform-services.example.yaml"), "utf8")
        .then((value) => parse(value) as UnknownRecord),
    ]);
    const expectedEnvironment = Object.fromEntries(
      PLATFORM_API_RUNTIME_CONTRACT.files.map(({ environment, filename }) => [
        environment,
        target(filename),
      ]),
    );
    const expectedSecretClasses = [
      "platform-api-database",
      ...new Set(PLATFORM_API_RUNTIME_CONTRACT.files.map(({ secretClass }) => secretClass)),
    ];

    const deployable = records(deployableDocument.deployables)
      .find((candidate) => candidate.id === "platform-api");
    expect(deployable).toBeDefined();
    expect(record(deployable).outboundContracts).toEqual([]);
    expect(record(deployable).secretClasses).toEqual(expectedSecretClasses);
    expect(record(deployable).ports).toEqual([
      { name: "public", containerPort: 4100, protocol: "https", exposure: "service", mtls: true },
      { name: "health", containerPort: 4101, protocol: "http", exposure: "pod-only", mtls: false },
    ]);
    expect(record(deployable).fileContract).toEqual({
      trustRootEnvironment: PLATFORM_API_RUNTIME_CONTRACT.trustRootEnvironment,
      mountPath: PLATFORM_API_RUNTIME_CONTRACT.trustRootPath,
      defaultMode: "0440",
      requiredEnvironment: PLATFORM_API_RUNTIME_CONTRACT.files.map(({ environment }) => environment),
    });
    expect(record(deployable).probes).toEqual({
      liveness: { path: "/health/live", port: "health", scheme: "HTTP" },
      readiness: { path: "/health/ready", port: "health", scheme: "HTTP" },
    });

    const composeApi = record(record(composeDocument.services)["platform-api"]);
    expect(record(composeApi.environment)).toMatchObject({
      PLATFORM_API_PORT: 4100,
      PLATFORM_API_HEALTH_PORT: 4101,
      [PLATFORM_API_RUNTIME_CONTRACT.trustRootEnvironment]:
        PLATFORM_API_RUNTIME_CONTRACT.trustRootPath,
      ...expectedEnvironment,
    });
    const composeMounts = records(composeApi.volumes).map((mount) => ({
      type: mount.type,
      source: mount.source,
      target: mount.target,
      read_only: mount.read_only,
    }));
    expect(composeMounts).toEqual(PLATFORM_API_RUNTIME_CONTRACT.files.map(({ environment, filename }) => ({
      type: "bind",
      source: `\${${environment}:?required}`,
      target: target(filename),
      read_only: true,
    })));
    expect(composeApi.ports).toEqual(["4100:4100"]);
    expect(record(composeApi.healthcheck).test).toEqual([
      "CMD", "node", "-e",
      "fetch('http://127.0.0.1:4101/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
    ]);
    expect(composeApi.read_only).toBe(true);

    const kubernetesItems = records(kubernetesDocument.items);
    const deployment = named(kubernetesItems, "Deployment", "platform-api");
    const podSpec = record(record(record(deployment.spec).template).spec);
    expect(podSpec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    const container = records(podSpec.containers)[0]!;
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(Object.fromEntries(records(container.env).map((entry) => [entry.name, entry.value])))
      .toMatchObject({
        PLATFORM_API_PORT: "4100",
        PLATFORM_API_HEALTH_PORT: "4101",
        [PLATFORM_API_RUNTIME_CONTRACT.trustRootEnvironment]:
          PLATFORM_API_RUNTIME_CONTRACT.trustRootPath,
        ...expectedEnvironment,
      });
    expect(container.ports).toEqual([
      { name: "public", containerPort: 4100 },
      { name: "health", containerPort: 4101 },
    ]);
    expect(container.livenessProbe).toMatchObject({
      httpGet: { path: "/health/live", port: "health", scheme: "HTTP" },
    });
    expect(container.readinessProbe).toMatchObject({
      httpGet: { path: "/health/ready", port: "health", scheme: "HTTP" },
    });
    expect(container.volumeMounts).toEqual([
      { name: "platform-api-files", mountPath: PLATFORM_API_RUNTIME_CONTRACT.trustRootPath,
        readOnly: true },
    ]);
    const secretVolume = records(podSpec.volumes).find((volume) => volume.name === "platform-api-files");
    expect(record(secretVolume).secret).toEqual({
      secretName: "platform-api-files",
      defaultMode: 288,
      items: PLATFORM_API_RUNTIME_CONTRACT.files.map(({ filename }) => ({
        key: filename,
        path: filename,
      })),
    });
    const service = named(kubernetesItems, "Service", "platform-api");
    expect(record(service.spec).ports).toEqual([
      { name: "public", port: 4100, targetPort: "public" },
    ]);
  });
});
