import { generateKeyPairSync } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { createEd25519CapabilityCatalogSigner } from
  "../../src/domain/capability-catalog.js";
import type { CapabilityProjectionDelivery } from
  "../../src/domain/capability-publication-repository.js";
import {
  CapabilityProjectionDeliveryError,
  createPlatformCapabilityProjectionClientForTransport,
} from "../../../src/modules/hub/infrastructure/connect/platform-capability-projection-client.js";
import {
  CapabilityCatalogProjectionService,
  CatalogProjectionState,
  GetProjectionReceiptResponseSchema,
  ProjectCatalogResponseSchema,
} from "../../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import {
  CommandReceiptSchema,
  CommandReceiptState,
} from "../../../src/generated/proto/kokoro/common/v1/receipt_pb.js";

describe("Platform capability projection client", () => {
  it("recovers an ambiguous dispatch through the exact receipt without redispatch", async () => {
    let projects = 0;
    let receipts = 0;
    const transport = createRouterTransport((router) => router.service(CapabilityCatalogProjectionService, {
      projectCatalog() {
        projects += 1;
        throw new ConnectError("response lost", Code.Unavailable);
      },
      getProjectionReceipt(request) {
        receipts += 1;
        return create(GetProjectionReceiptResponseSchema, {
          receipt: create(CommandReceiptSchema, {
            identity: {
              commandId: request.commandId,
              idempotencyKey: request.idempotencyKey,
              digestAlgorithm: request.digestAlgorithm,
              requestDigest: request.requestDigest,
            },
            operation: "capability_catalog.project",
            state: CommandReceiptState.COMMITTED,
            recordedAt: timestampFromDate(new Date("2026-07-29T12:00:00.000Z")),
          }),
          agentCatalogRef: delivery().publication.agentCatalogRef,
          projectionState: CatalogProjectionState.COMMITTED,
        });
      },
    }));
    const client = createPlatformCapabilityProjectionClientForTransport(transport);
    await expect(client.project(delivery(), new AbortController().signal)).resolves.toBeUndefined();
    expect({ projects, receipts }).toEqual({ projects: 1, receipts: 1 });
  });

  it("rejects a committed response that does not match the frozen catalog", async () => {
    const transport = createRouterTransport((router) => router.service(CapabilityCatalogProjectionService, {
      projectCatalog(request) {
        return create(ProjectCatalogResponseSchema, {
          receipt: create(CommandReceiptSchema, {
            identity: request.command,
            operation: "capability_catalog.project",
            state: CommandReceiptState.COMMITTED,
            recordedAt: timestampFromDate(new Date("2026-07-29T12:00:00.000Z")),
          }),
          agentCatalogRef: "agent-catalog:wrong",
          projectionState: CatalogProjectionState.COMMITTED,
        });
      },
      getProjectionReceipt() { throw new Error("must not reconcile a terminal mismatch"); },
    }));
    const client = createPlatformCapabilityProjectionClientForTransport(transport);
    await expect(client.project(delivery(), new AbortController().signal)).rejects.toMatchObject({
      name: CapabilityProjectionDeliveryError.name,
      disposition: "rejected",
    });
  });
});

function delivery(): CapabilityProjectionDelivery {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publication = createEd25519CapabilityCatalogSigner({
    signingKeyRef: "hub-signing:revision:7",
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  }).sign({
    siteId: "site-a",
    siteReleaseRef: "release-7",
    frozenAt: "2026-07-29T12:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      agentOptions: [{ optionRef: "agent:main", agent: "main", label: "Main" }],
      defaultAgentOptionRef: "agent:main",
      tools: [], skillOptions: [], mcpOptions: [], subagents: [],
    },
  });
  return Object.freeze({
    commandId: "freeze-1",
    idempotencyKey: "site-release-1",
    requestDigest: "1".repeat(64),
    publication,
    recordedAt: publication.frozenAt,
    projectionState: "outcome_unknown",
    replayed: false,
    leaseId: "lease-1",
    attempt: 1,
  });
}
