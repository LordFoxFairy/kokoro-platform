import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import {
  AgentImageIntentV1Schema,
} from "../../src/interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_runtime_pb.js";
import {
  CanonicalImageAspectRatio,
  CanonicalImageOutputFormat,
} from "../../src/interfaces/connect/generated-media-runtime/kokoro/platform/media/v1/media_canonical_pb.js";
import { PostgresAgentImageAccessOwner } from
  "../../src/modules/media/infrastructure/postgres/agent-image-access-owner.js";

describe("PostgresAgentImageAccessOwner", () => {
  it("resolves both opaque handles and returns only owner-frozen SiteRelease facts", async () => {
    const key = randomBytes(32);
    const database = { resolveAgentImageAccess: vi.fn(async () => [row()]) };
    const owner = new PostgresAgentImageAccessOwner({ database, mediaAccessKey: key });
    const input = {
      mediaAccessHandle: "media_access_v1." + "a".repeat(43),
      mediaProjectionReservationHandle: "projection_reservation_v1." + "p".repeat(43),
      stableOutputSlotRef: "slot:image-1",
      agentMediaCommandRef: "agent-media-command:one",
      imageIntent: create(AgentImageIntentV1Schema, { promptIntent: "fox",
        aspectRatio: CanonicalImageAspectRatio.SQUARE_1_1, candidateCount: 1,
        outputFormat: CanonicalImageOutputFormat.PNG }),
    };

    const resolved = await owner.resolveAgentImage(input, new AbortController().signal);

    expect(database.resolveAgentImageAccess).toHaveBeenCalledWith({
      handleDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      projectionReservationDigest: createHmac("sha256", key)
        .update("kokoro.platform.media-projection-reservation-handle.v1\0")
        .update(frame(input.mediaProjectionReservationHandle)).digest("hex"),
    });
    expect(resolved).toMatchObject({ budgetSource: { kind: "agent_child",
      executionBudgetRootRef: "00000000-0000-4000-8000-000000000001",
      parentAllocationRef: "00000000-0000-4000-8000-000000000003",
      expectedParentRevision: 4n, expectedParentAllocationEpoch: 3n }, maximumCredit: 120n,
      trustInputDecisionRef: "site-policy-decision:one",
      ownerBinding: { siteRef: "site:one", projectRef: "project:one", subjectGeneration: 3n,
        source: "agent_runtime", definitionRevisionRef: "image.text_to_image@v1:revision:1",
        modelOptionRevisionRef: "image-model:revision:7",
        workloadRef: expect.stringMatching(/^agent-media-workload:sha256:[0-9a-f]{64}$/u) } });
  });

  it("rejects undersized handles before consulting PostgreSQL", async () => {
    const database = { resolveAgentImageAccess: vi.fn(async () => [row()]) };
    const owner = new PostgresAgentImageAccessOwner({ database, mediaAccessKey: randomBytes(32) });
    await expect(owner.resolveAgentImage({
      mediaAccessHandle: "short", mediaProjectionReservationHandle: "also-short",
      stableOutputSlotRef: "slot:image-1", agentMediaCommandRef: "command:one",
      imageIntent: create(AgentImageIntentV1Schema),
    }, new AbortController().signal)).rejects.toThrow("MEDIA_OPAQUE_HANDLE_INVALID");
    expect(database.resolveAgentImageAccess).not.toHaveBeenCalled();
  });
});

function row() {
  return Object.freeze({
    siteRef: "site:one", projectRef: "project:one", sessionRef: "session:one", runRef: "run:one",
    subjectRef: "subject:one", subjectGeneration: "3", configurationRevisionRef: "release:one",
    executionBudgetRootRef: "00000000-0000-4000-8000-000000000001",
    authorizationSegmentRef: "00000000-0000-4000-8000-000000000002",
    parentAllocationRef: "00000000-0000-4000-8000-000000000003", maximumCredit: "120",
    trustInputDecisionRef: "site-policy-decision:one",
    expectedParentRevision: "4", expectedParentAllocationEpoch: "3",
    creditSurfaceRef: "surface:image", creditCapabilityKey: "image.create",
    creditAgentRef: "agent:one", creditExpiresAt: "2026-07-31T13:00:00.000Z",
    definitionRevisionRef: "image.text_to_image@v1:revision:1",
    modelOptionRevisionRef: "image-model:revision:7",
  });
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}
