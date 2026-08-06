import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  CapabilityCatalogSnapshotSchema,
  FrozenCatalogPublicationSchema,
  ProjectCatalogRequestSchema,
  SignatureAlgorithm,
} from "../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm, CommandIdentitySchema } from
  "../../src/generated/proto/kokoro/common/v1/receipt_pb.js";
import {
  capabilityProjectionRequestDigest,
  createCapabilityCatalogProjectionConnectService,
} from "../../src/modules/admission/interfaces/connect/capability-catalog-projection-service.js";

describe("CapabilityCatalogProjection Connect service", () => {
  it("authenticates Hub, verifies protobuf digest, and returns exact replay state", async () => {
    const publication = create(FrozenCatalogPublicationSchema, {
      siteId: "site-a",
      siteReleaseRef: "release-a",
      agentCatalogRef: `agent-catalog:sha256:${"a".repeat(64)}`,
      snapshotDigest: "a".repeat(64),
      snapshot: create(CapabilityCatalogSnapshotSchema, { schemaVersion: 1 }),
      frozenAt: timestampFromDate(new Date("2026-07-29T12:00:00.000Z")),
      signingKeyRef: "hub-key-a",
      signatureAlgorithm: SignatureAlgorithm.ED25519_SHA256_V1,
      signaturePayloadDigest: "b".repeat(64),
      signature: new Uint8Array(64).fill(1),
    });
    const command = create(CommandIdentitySchema, {
      commandId: "command-a",
      idempotencyKey: "idem-a",
      digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
      requestDigest: capabilityProjectionRequestDigest(publication),
    });
    let projected = 0;
    const service = createCapabilityCatalogProjectionConnectService({
      hubCallerIdentity: "spiffe://kokoro/hub",
      caller: { resolve: () => ({ identity: "spiffe://kokoro/hub" }) },
      verifyPublication: (value) => value,
      repository: {
        project: async (input) => {
          projected += 1;
          expect(input.commandId).toBe(command.commandId);
          expect(input.publication.siteReleaseRef).toBe("release-a");
          return { agentCatalogRef: publication.agentCatalogRef, recordedAt: "2026-07-29T12:00:01.000Z", replayed: true };
        },
        lookup: async () => null,
      },
    });

    const response = await service.projectCatalog(create(ProjectCatalogRequestSchema, { command, publication }), {} as never);
    expect(response.replayed).toBe(true);
    expect(response.receipt?.identity?.requestDigest).toBe(command.requestDigest);
    expect(projected).toBe(1);
  });

  it("rejects wrong caller and request-digest conflict before persistence", async () => {
    const service = createCapabilityCatalogProjectionConnectService({
      hubCallerIdentity: "spiffe://kokoro/hub",
      caller: { resolve: () => ({ identity: "spiffe://kokoro/other" }) },
      verifyPublication: (value) => value,
      repository: { project: async () => { throw new Error("must not persist"); }, lookup: async () => null },
    });
    await expect(service.projectCatalog(create(ProjectCatalogRequestSchema), {} as never)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.PermissionDenied,
    );
  });
});
