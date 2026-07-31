import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

describe("Artifact data-plane deployment boundary", () => {
  it("ships one independently selectable certified process with pod-only health", async () => {
    const [manifestSource, composeSource, kubernetesSource, entrypoint] = await Promise.all([
      readFile("deployables.yaml", "utf8"),
      readFile("deploy/docker-compose.services.yml", "utf8"),
      readFile("deploy/k8s/platform-services.example.yaml", "utf8"),
      readFile("deploy/docker/runtime-entrypoint.mjs", "utf8"),
    ]);
    const manifest = parse(manifestSource) as Readonly<{ deployables: readonly Readonly<{
      id: string; activationAuthorized: boolean; runtimeTraffic: boolean;
      declaredInboundContracts: readonly string[];
    }>[] }>;
    const deployable = manifest.deployables.find((item) => item.id === "platform-artifact-data-plane");
    expect(deployable).toMatchObject({ activationAuthorized: true, runtimeTraffic: true,
      declaredInboundContracts: [] });
    const compose = parse(composeSource) as Readonly<{ services: Readonly<Record<string,
      Readonly<{ profiles?: readonly string[] }>>> }>;
    expect(compose.services["platform-artifact-data-plane"]?.profiles).toBeUndefined();
    const resources = parseAllDocuments(kubernetesSource).map((document) => document.toJSON() as {
      kind?: string; items?: readonly Readonly<{ kind?: string; metadata?: { name?: string };
        spec?: { replicas?: number; template?: { spec?: { containers?: readonly {
          name?: string; ports?: readonly { name?: string; containerPort?: number }[];
          readinessProbe?: { httpGet?: { port?: string; scheme?: string } } }[] } } } }>[];
    }).flatMap((resource) => resource.kind === "List" ? resource.items ?? [] : [resource]);
    const deployment = resources.find((resource) =>
      resource.kind === "Deployment" && resource.metadata?.name === "platform-artifact-data-plane");
    expect(deployment?.spec?.replicas).toBe(2);
    const container = deployment?.spec?.template?.spec?.containers?.find((item) =>
      item.name === "platform-artifact-data-plane");
    expect(container?.ports).toContainEqual({ name: "health", containerPort: 4249 });
    expect(container?.readinessProbe?.httpGet).toMatchObject({ port: "health", scheme: "HTTP" });
    expect(entrypoint).toContain('"platform-artifact-data-plane"');
  });

  it("owns metadata, authorization and audit through exact least-privilege routines", async () => {
    const [migration, migrator, workflow, provision] = await Promise.all([
      readFile("prisma/migrations/20260811_artifact_delivery_data_plane/migration.sql", "utf8"),
      readFile("src/infrastructure/postgres/migrator.ts", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
      readFile("scripts/ci/provision-platform-postgres.sql", "utf8"),
    ]);
    for (const routine of [
      "list_owned_artifacts", "get_owned_artifact", "list_owned_artifact_versions",
      "get_owned_artifact_version", "create_artifact_delivery_authorization",
      "revoke_owned_artifact_delivery_authorization",
      "find_artifact_delivery_authorization_by_capability",
      "begin_artifact_delivery_redemption", "complete_artifact_delivery_stream",
      "fail_artifact_delivery_stream",
    ]) expect(migration).toContain(`platform.${routine}`);
    expect(migration).toMatch(/GRANT EXECUTE[\s\S]+TO platform_artifact_data_plane;/u);
    expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE)[\s\S]{0,160}TO platform_artifact_data_plane/u);
    expect(migrator).toContain("PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE");
    expect(migrator).toContain("grantArtifactDataPlanePrivileges");
    expect(workflow).toContain("PLATFORM_DATABASE_ARTIFACT_DATA_PLANE_ROLE: platform_artifact_data_plane");
    expect(provision).toContain("CREATE ROLE platform_artifact_data_plane");
  });
});
