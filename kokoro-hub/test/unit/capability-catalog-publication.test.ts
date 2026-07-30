import { generateKeyPairSync, verify } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { CapabilityCatalogPublicationService } from
  "../../src/application/capability-catalog-publication-service.js";
import { createEd25519CapabilityCatalogSigner } from
  "../../src/domain/capability-catalog.js";
import type { CapabilityCatalogPublicationRecord } from
  "../../src/domain/capability-publication-repository.js";
import {
  createHubCatalogConnectService,
  createHubRuntimeConnectService,
  freezeCatalogRequestDigest,
} from "../../src/interfaces/connect/capability-catalog-services.js";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FreezeCatalogEffectSchema,
  HubCatalogService,
  HubRuntimeService,
} from "../../src/interfaces/connect/generated-capability-catalog/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm } from
  "../../src/interfaces/connect/generated-capability-catalog/kokoro/common/v1/receipt_pb.js";

const SNAPSHOT = {
  schemaVersion: 1 as const,
  agentOptions: [
    { optionRef: "agent:z", agent: "z", label: "Z" },
    { optionRef: "agent:a", agent: "a", label: "A" },
  ],
  defaultAgentOptionRef: "agent:a",
  tools: ["web", "deliver"],
  skillOptions: [],
  mcpOptions: [],
  subagents: ["research", "writer"],
};

describe("signed capability catalog publication", () => {
  it("returns the original immutable publication for an exact command replay", async () => {
    const existing = publicationRecord();
    const authority = { assertCurrent: vi.fn() };
    const freeze = vi.fn();
    const service = new CapabilityCatalogPublicationService({
      authority,
      signer: { sign: vi.fn() },
      repository: {
        get: vi.fn().mockResolvedValue(existing),
        findByAgentCatalogRef: vi.fn(),
        freeze,
        claimProjection: vi.fn(), completeProjection: vi.fn(), deferProjection: vi.fn(),
      },
    });
    await expect(service.freeze({
      commandId: existing.commandId,
      idempotencyKey: existing.idempotencyKey,
      requestDigest: existing.requestDigest,
      siteId: existing.publication.siteId,
      siteReleaseRef: existing.publication.siteReleaseRef,
      snapshot: SNAPSHOT,
    })).resolves.toBe(existing);
    expect(authority.assertCurrent).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
  });

  it("canonicalizes, binds and signs the exact release snapshot", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = createEd25519CapabilityCatalogSigner({
      signingKeyRef: "hub-signing:revision:7",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const freeze = vi.fn();
    const authority = { assertCurrent: vi.fn().mockResolvedValue(undefined) };
    const service = new CapabilityCatalogPublicationService({
      authority,
      signer,
      clock: () => new Date("2026-07-29T12:00:00.000Z"),
      repository: {
        freeze: async (command) => {
          freeze(command);
          return Object.freeze({
            ...command,
            recordedAt: command.publication.frozenAt,
            projectionState: "pending" as const,
            replayed: false,
          });
        },
        get: vi.fn().mockResolvedValue(null),
        findByAgentCatalogRef: vi.fn(),
        claimProjection: vi.fn(), completeProjection: vi.fn(), deferProjection: vi.fn(),
      },
    });
    const record = await service.freeze({
      commandId: "freeze-1",
      idempotencyKey: "site-release-1",
      requestDigest: "1".repeat(64),
      siteId: "site-a",
      siteReleaseRef: "release-7",
      snapshot: SNAPSHOT,
    });
    expect(record.publication.snapshot.agentOptions.map(({ optionRef }) => optionRef))
      .toEqual(["agent:a", "agent:z"]);
    expect(record.publication.agentCatalogRef)
      .toBe(`agent-catalog:sha256:${record.publication.snapshotDigest}`);
    expect(record.publication.signingKeyRef).toBe("hub-signing:revision:7");
    expect(verify(
      null,
      Buffer.from(record.publication.signaturePayloadDigest, "hex"),
      publicKey,
      record.publication.signature,
    )).toBe(true);
    expect(authority.assertCurrent).toHaveBeenCalledOnce();
    expect(freeze).toHaveBeenCalledOnce();
  });

  it("exposes exact caller-scoped catalog and Agent-only execution assembly", async () => {
    const snapshot = create(CapabilityCatalogSnapshotSchema, SNAPSHOT);
    const effect = create(FreezeCatalogEffectSchema, {
      siteId: "site-a",
      siteReleaseRef: "release-7",
      snapshot,
    });
    const record = publicationRecord();
    const platformCaller = "spiffe://kokoro/platform";
    const agentCaller = "spiffe://kokoro/agent";
    const resolveAssembly = vi.fn().mockResolvedValue({
      agentCatalogRef: record.publication.agentCatalogRef,
      assemblyDigest: "a".repeat(64),
      skills: [],
      mcpServers: [],
    });
    const catalog = createHubCatalogConnectService({
      publication: {
        freeze: vi.fn().mockResolvedValue(record),
        get: vi.fn().mockResolvedValue(record),
      },
      caller: { resolve: () => ({ identity: platformCaller }) },
      platformCallerIdentity: platformCaller,
    });
    const runtime = createHubRuntimeConnectService({
      assembly: { resolve: resolveAssembly, fetchArtifact: vi.fn() },
      caller: { resolve: () => ({ identity: agentCaller }) },
      agentCallerIdentity: agentCaller,
    });
    const transport = createRouterTransport((router) => {
      router.service(HubCatalogService, catalog);
      router.service(HubRuntimeService, runtime);
    });
    const catalogClient = (await import("@connectrpc/connect")).createClient(HubCatalogService, transport);
    const frozen = await catalogClient.freezeCatalog({
      command: {
        commandId: "freeze-1",
        idempotencyKey: "site-release-1",
        digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
        requestDigest: freezeCatalogRequestDigest(effect),
      },
      effect,
    });
    expect(frozen.projectionState).toBe(CatalogProjectionState.PENDING);
    expect(frozen.publication?.agentCatalogRef).toBe(record.publication.agentCatalogRef);

    const runtimeClient = (await import("@connectrpc/connect")).createClient(HubRuntimeService, transport);
    await expect(runtimeClient.resolveExecutionAssembly({
      namespace: "opaque-ns",
      agentCatalogRef: record.publication.agentCatalogRef,
      skillGrants: [],
      mcpGrants: [],
    })).resolves.toMatchObject({
      agentCatalogRef: record.publication.agentCatalogRef,
      assemblyDigest: "a".repeat(64),
      skills: [],
      mcpServers: [],
    });
    expect(resolveAssembly).toHaveBeenCalledWith({
      namespace: "opaque-ns",
      agentCatalogRef: record.publication.agentCatalogRef,
      skills: [],
      mcpServers: [],
    });
  });
});

function publicationRecord(): CapabilityCatalogPublicationRecord {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publication = createEd25519CapabilityCatalogSigner({
    signingKeyRef: "hub-signing:revision:7",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }).sign({
    siteId: "site-a",
    siteReleaseRef: "release-7",
    snapshot: SNAPSHOT,
    frozenAt: "2026-07-29T12:00:00.000Z",
  });
  return Object.freeze({
    commandId: "freeze-1",
    idempotencyKey: "site-release-1",
    requestDigest: "1".repeat(64),
    publication,
    recordedAt: publication.frozenAt,
    projectionState: "pending",
    replayed: false,
  });
}
