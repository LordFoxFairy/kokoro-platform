import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ExecutionAssemblyError,
  ExecutionAssemblyService,
  executionAssemblyDigest,
} from "../../src/application/execution-assembly-service.js";
import { createEd25519CapabilityCatalogSigner } from
  "../../src/domain/capability-catalog.js";
import type { CapabilityCatalogPublicationRecord } from
  "../../src/domain/capability-publication-repository.js";
import { contentHashOf, packageRef } from "../../src/domain/package.js";
import { zipTextFiles } from "../../src/infrastructure/zip.js";

const NAMESPACE = "namespace-a";
const SKILL_NAME = "research-tool";
const SKILL_DESCRIPTION = "Research safely";
const SKILL_FILES = {
  "SKILL.md": `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n# Instructions\n`,
  "reference.txt": "bounded reference",
};
const SKILL_HASH = contentHashOf(SKILL_FILES);
const SKILL_REF = "skill:research";
const MCP_REF = "mcp:docs";
const MCP_HASH = "b".repeat(64);
const SECRET_HANDLE = `srt_${"1".repeat(32)}`;
const AUTHORIZATION = "Bearer secret-marker-not-real";

describe("execution assembly service", () => {
  it("binds exact frozen selections, live revisions, artifacts and secret material", async () => {
    const fixture = build();
    const signal = new AbortController().signal;
    const result = await fixture.service.resolve(request(), signal);

    expect(result.agentCatalogRef).toBe(fixture.publication.publication.agentCatalogRef);
    expect(result.skills).toEqual([expect.objectContaining({
      optionRef: SKILL_REF,
      scope: NAMESPACE,
      name: SKILL_NAME,
      contentHash: SKILL_HASH,
      artifactRef: packageRef(NAMESPACE, SKILL_NAME, SKILL_HASH),
    })]);
    expect(result.mcpServers).toEqual([expect.objectContaining({
      optionRef: MCP_REF,
      scope: "official",
      name: "docs",
      revision: 7,
      configHash: MCP_HASH,
      url: "https://mcp.example.com/rpc",
      authorizationValue: AUTHORIZATION,
    })]);
    expect(result.assemblyDigest).toBe(executionAssemblyDigest({
      namespace: NAMESPACE,
      agentCatalogRef: result.agentCatalogRef,
      skills: result.skills,
      mcpServers: result.mcpServers,
    }));
    expect(fixture.resolveSecrets).toHaveBeenCalledWith(NAMESPACE, [SECRET_HANDLE]);
    expect(fixture.getArtifact).toHaveBeenCalledWith(
      packageRef(NAMESPACE, SKILL_NAME, SKILL_HASH),
      signal,
    );
    expect(result.assemblyDigest).not.toContain(AUTHORIZATION);
  });

  it("rejects duplicate option refs and duplicate scope/name before touching authorities", async () => {
    const fixture = build();
    const base = request();
    for (const value of [
      { ...base, skills: [base.skills[0]!, base.skills[0]!] },
      { ...base, mcpServers: [base.mcpServers[0]!, { ...base.mcpServers[0]!, optionRef: "mcp:other" }] },
    ]) {
      await expect(fixture.service.resolve(value)).rejects.toMatchObject({
        code: "HUB_EXECUTION_ASSEMBLY_REQUEST_INVALID",
      });
    }
    expect(fixture.findPublication).not.toHaveBeenCalled();
  });

  it("rejects options absent from the frozen catalog and cross-namespace scope without resolving secrets", async () => {
    for (const mutate of [
      () => ({ ...request(), mcpServers: [{ ...request().mcpServers[0]!, optionRef: "mcp:arbitrary" }] }),
      () => ({ ...request(), skills: [{ ...request().skills[0]!, scope: "namespace-b" }] }),
    ]) {
      const fixture = build();
      await expect(fixture.service.resolve(mutate())).rejects.toMatchObject({
        code: "HUB_EXECUTION_ASSEMBLY_SELECTION_INVALID",
      });
      expect(fixture.resolveSecrets).not.toHaveBeenCalled();
    }
  });

  it("fails closed when a selected MCP revision is disabled or changed", async () => {
    const fixture = build({ mcpEnabled: false });
    await expect(fixture.service.resolve(request())).rejects.toMatchObject({
      code: "HUB_EXECUTION_ASSEMBLY_CAPABILITY_REVOKED",
    });
    expect(fixture.resolveSecrets).not.toHaveBeenCalled();
  });

  it("streams only the exact manifest-bound immutable artifact", async () => {
    const fixture = build();
    const assembly = await fixture.service.resolve(request());
    const manifest = assembly.skills[0]!;
    const data = await fixture.service.fetchArtifact({
      namespace: NAMESPACE,
      agentCatalogRef: assembly.agentCatalogRef,
      grant: request().skills[0]!,
      artifactRef: manifest.artifactRef,
      expectedSize: manifest.artifactSize,
      expectedSha256: manifest.artifactSha256,
    });
    expect(data).toEqual(zipTextFiles(SKILL_FILES));

    await expect(fixture.service.fetchArtifact({
      namespace: NAMESPACE,
      agentCatalogRef: assembly.agentCatalogRef,
      grant: request().skills[0]!,
      artifactRef: `${manifest.artifactRef}-wrong`,
      expectedSize: manifest.artifactSize,
      expectedSha256: manifest.artifactSha256,
    })).rejects.toBeInstanceOf(ExecutionAssemblyError);
  });

  it("assembly digest binds authorization presence without hashing plaintext", () => {
    const common = {
      namespace: NAMESPACE,
      agentCatalogRef: `agent-catalog:sha256:${"a".repeat(64)}`,
      skills: [],
    };
    const server = {
      optionRef: MCP_REF,
      scope: "official",
      name: "docs",
      revision: 1,
      configHash: MCP_HASH,
      transport: "streamable_http" as const,
      url: "https://mcp.example.com/rpc",
      allowedTools: ["search"],
    };
    const first = executionAssemblyDigest({
      ...common,
      mcpServers: [{ ...server, authorizationValue: "Bearer first-secret" }],
    });
    const rotated = executionAssemblyDigest({
      ...common,
      mcpServers: [{ ...server, authorizationValue: "Bearer rotated-secret" }],
    });
    const absent = executionAssemblyDigest({ ...common, mcpServers: [server] });
    expect(first).toBe(rotated);
    expect(first).not.toBe(absent);
    expect(first).not.toContain("secret");
  });
});

function request() {
  const publication = publicationRecord();
  return {
    namespace: NAMESPACE,
    agentCatalogRef: publication.publication.agentCatalogRef,
    skills: [{
      optionRef: SKILL_REF,
      scope: NAMESPACE,
      name: SKILL_NAME,
      contentHash: SKILL_HASH,
      description: SKILL_DESCRIPTION,
    }],
    mcpServers: [{
      optionRef: MCP_REF,
      scope: "official",
      name: "docs",
      revision: 7,
      configHash: MCP_HASH,
    }],
  };
}

function build(options: Readonly<{ mcpEnabled?: boolean }> = {}) {
  const publication = publicationRecord();
  const findPublication = vi.fn().mockResolvedValue(publication);
  const resolveSecrets = vi.fn().mockResolvedValue({ [SECRET_HANDLE]: AUTHORIZATION });
  const artifact = zipTextFiles(SKILL_FILES);
  const getArtifact = vi.fn().mockResolvedValue(artifact);
  return {
    publication,
    findPublication,
    resolveSecrets,
    getArtifact,
    service: new ExecutionAssemblyService({
      publications: { findByAgentCatalogRef: findPublication },
      skills: { findActive: vi.fn().mockResolvedValue({
        contentHash: SKILL_HASH,
        revision: 1,
        packageSize: Buffer.byteLength(SKILL_FILES["SKILL.md"]),
      }) },
      mcp: { getRevisionSnapshot: vi.fn().mockResolvedValue({
        snapshot: {
          scope: "official",
          name: "docs",
          revision: 7,
          config_hash: MCP_HASH,
          transport: "streamable_http",
          url: "https://mcp.example.com/rpc",
          allowed_tools: ["search", "read"],
          secret_ref: `handle:${SECRET_HANDLE}`,
        },
        live: { enabled: options.mcpEnabled ?? true, deleted: false },
      }) },
      secrets: { resolve: resolveSecrets },
      packages: { get: getArtifact },
    }),
  };
}

function publicationRecord(): CapabilityCatalogPublicationRecord {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publication = createEd25519CapabilityCatalogSigner({
    signingKeyRef: "hub-signing:revision:test",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }).sign({
    siteId: "site-a",
    siteReleaseRef: "release-a",
    frozenAt: "2026-07-29T12:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      agentOptions: [],
      tools: [],
      skillOptions: [{
        optionRef: SKILL_REF,
        label: "Research",
        scope: NAMESPACE,
        name: SKILL_NAME,
        contentHash: SKILL_HASH,
        description: SKILL_DESCRIPTION,
      }],
      mcpOptions: [{
        optionRef: MCP_REF,
        label: "Docs",
        scope: "official",
        name: "docs",
        revision: 7,
        configHash: MCP_HASH,
      }],
      subagents: [],
    },
  });
  return Object.freeze({
    commandId: "freeze-test",
    idempotencyKey: "release-a",
    requestDigest: "d".repeat(64),
    publication,
    recordedAt: publication.frozenAt,
    projectionState: "committed",
    replayed: false,
  });
}
