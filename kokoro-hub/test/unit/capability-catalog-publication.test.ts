import { generateKeyPairSync, verify } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createHandlerContext, createRouterTransport } from "@connectrpc/connect";
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
} from "../../../src/modules/hub/interfaces/connect/capability-catalog-services.js";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FetchSkillArtifactRequestSchema,
  FreezeCatalogEffectSchema,
  FreezeCatalogRequestSchema,
  GetCatalogPublicationRequestSchema,
  HubCatalogService,
  HubRuntimeService,
  SkillGrantSelectionSchema,
} from "../../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm } from
  "../../../src/generated/proto/kokoro/common/v1/receipt_pb.js";

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
        claimProjection: vi.fn(), completeProjection: vi.fn(), releaseProjection: vi.fn(),
        deferProjection: vi.fn(),
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
        claimProjection: vi.fn(), completeProjection: vi.fn(), releaseProjection: vi.fn(),
        deferProjection: vi.fn(),
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
    }, expect.any(AbortSignal));
  });

  it("passes request cancellation through artifact fetch and stops chunking", async () => {
    const controller = new AbortController();
    const fetchArtifact = vi.fn().mockResolvedValue(Buffer.alloc(128 * 1024, 1));
    const runtime = createHubRuntimeConnectService({
      assembly: { resolve: vi.fn(), fetchArtifact },
      caller: { resolve: () => ({ identity: "spiffe://kokoro/agent" }) },
      agentCallerIdentity: "spiffe://kokoro/agent",
    });
    const context = createHandlerContext({
      service: HubRuntimeService,
      method: HubRuntimeService.method.fetchSkillArtifact,
      protocolName: "connect",
      requestMethod: "POST",
      url: "/kokoro.platform.capability.v1.HubRuntimeService/FetchSkillArtifact",
      requestSignal: controller.signal,
    });
    const stream = runtime.fetchSkillArtifact(create(FetchSkillArtifactRequestSchema, {
      namespace: "opaque-ns",
      agentCatalogRef: `agent-catalog:sha256:${"a".repeat(64)}`,
      grant: create(SkillGrantSelectionSchema, {
        optionRef: "skill:research",
        scope: "opaque-ns",
        name: "research",
        contentHash: "b".repeat(64),
        description: "Research",
      }),
      artifactRef: "skills/opaque-ns/research/package.zip",
      expectedSize: 128n * 1024n,
      expectedSha256: "c".repeat(64),
    }), context)[Symbol.asyncIterator]();

    await expect(stream.next()).resolves.toMatchObject({ done: false });
    controller.abort(new ConnectError("request canceled", Code.Canceled));
    await expect(stream.next()).rejects.toSatisfy((error: unknown) =>
      ConnectError.from(error).code === Code.Canceled);
    expect(fetchArtifact).toHaveBeenCalledWith(expect.any(Object), context.signal);
  });

  it("fences catalog owner calls before dispatch and after an in-flight cancellation", async () => {
    const platformCaller = "spiffe://kokoro/platform";
    const frozen = publicationRecord();
    const freeze = vi.fn().mockResolvedValue(frozen);
    const delayedGet = deferredValue<CapabilityCatalogPublicationRecord>();
    const get = vi.fn().mockReturnValue(delayedGet.promise);
    const catalog = createHubCatalogConnectService({
      publication: { freeze, get },
      caller: { resolve: () => ({ identity: platformCaller }) },
      platformCallerIdentity: platformCaller,
    });
    const snapshot = create(CapabilityCatalogSnapshotSchema, SNAPSHOT);
    const effect = create(FreezeCatalogEffectSchema, {
      siteId: "site-a",
      siteReleaseRef: "release-7",
      snapshot,
    });
    const expired = new AbortController();
    expired.abort(new ConnectError("request deadline exceeded", Code.DeadlineExceeded));
    const freezeContext = createHandlerContext({
      service: HubCatalogService,
      method: HubCatalogService.method.freezeCatalog,
      protocolName: "connect",
      requestMethod: "POST",
      url: "/kokoro.platform.capability.v1.HubCatalogService/FreezeCatalog",
      requestSignal: expired.signal,
    });
    await expect(catalog.freezeCatalog(create(FreezeCatalogRequestSchema, {
      command: {
        commandId: "freeze-1",
        idempotencyKey: "release-7",
        digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
        requestDigest: freezeCatalogRequestDigest(effect),
      },
      effect,
    }), freezeContext)).rejects.toSatisfy((error: unknown) =>
      ConnectError.from(error).code === Code.DeadlineExceeded);
    expect(freeze).not.toHaveBeenCalled();

    const canceled = new AbortController();
    const getContext = createHandlerContext({
      service: HubCatalogService,
      method: HubCatalogService.method.getCatalogPublication,
      protocolName: "connect",
      requestMethod: "POST",
      url: "/kokoro.platform.capability.v1.HubCatalogService/GetCatalogPublication",
      requestSignal: canceled.signal,
    });
    const result = catalog.getCatalogPublication(create(GetCatalogPublicationRequestSchema, {
      commandId: "freeze-1",
      idempotencyKey: "release-7",
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest: "1".repeat(64),
      siteId: "site-a",
      siteReleaseRef: "release-7",
    }), getContext);
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    canceled.abort(new ConnectError("request canceled", Code.Canceled));
    delayedGet.resolve(frozen);
    await expect(result).rejects.toSatisfy((error: unknown) =>
      ConnectError.from(error).code === Code.Canceled);
  });
});

function deferredValue<Value>(): Readonly<{ promise: Promise<Value>; resolve(value: Value): void }> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolveValue) => { resolvePromise = resolveValue; });
  return Object.freeze({ promise, resolve: resolvePromise });
}

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
