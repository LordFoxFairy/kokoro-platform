import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  captureFencedLegacySnapshots,
  legacyExportFenceSigningPayload,
  sameLegacyDatabaseIdentity,
  verifyLegacyExportFenceAttestation,
  type LegacySnapshotParticipant,
} from "../../src/modules/model-control/migration/legacy-export-snapshot.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

describe("legacy ModelControl export snapshot", () => {
  it("recognizes the same MySQL database across distinct least-privilege credentials", () => {
    expect(
      sameLegacyDatabaseIdentity(
        "mysql://model_reader:a@db.internal:3306/kokoro?ssl=true",
        "mysql://site_reader:b@db.internal/kokoro?connection_limit=1",
      ),
    ).toBe(true);
    expect(
      sameLegacyDatabaseIdentity(
        "mysql://reader:a@db.internal/kokoro_model",
        "mysql://reader:a@db.internal/kokoro_site",
      ),
    ).toBe(false);
  });

  it("captures every participant inside one repeatable-read consistent snapshot", async () => {
    const events: string[] = [];
    const model = participant("model", "model-payload", stableWatermark(), events);
    const site = participant("site", "site-payload", stableWatermark(), events);
    const fence = signedFence(["model", "site"]);
    const result = await captureFencedLegacySnapshots(
      [model, site],
      fence,
      () => "2026-07-28T12:01:00.000Z",
    );

    expect(result.map(({ name, payload }) => [name, payload])).toEqual([
      ["model", "model-payload"],
      ["site", "site-payload"],
    ]);
    expect(events.filter((event) => event.endsWith(":begin"))).toHaveLength(2);
    expect(events.filter((event) => event.endsWith(":current"))).toHaveLength(4);
    expect(events.filter((event) => event.endsWith(":snapshot-watermark"))).toHaveLength(2);
    expect(events.indexOf("model:begin")).toBeLessThan(events.indexOf("model:payload"));
    expect(events.indexOf("site:begin")).toBeLessThan(events.indexOf("site:payload"));
    expect(events.filter((event) => event.endsWith(":commit"))).toHaveLength(2);
  });

  it("rejects a torn source when pre, snapshot, and post watermarks differ", async () => {
    const events: string[] = [];
    const changed = participant(
      "model",
      "payload",
      [stableWatermark(), { digest: "b".repeat(64), latestUpdatedAt: "2026-07-28T11:59:00.000Z" }],
      events,
    );
    const fence = signedFence(["model"]);
    await expect(
      captureFencedLegacySnapshots([changed], fence, () => "2026-07-28T12:01:00.000Z"),
    ).rejects.toThrowError("MODEL_LEGACY_EXPORT_FENCE_VIOLATED:model");
    expect(events).toContain("model:rollback");
    expect(events).not.toContain("model:payload");
    expect(events).not.toContain("model:commit");
  });

  it("rejects arbitrary strings, expired leases, and a live watermark not authorized by the owner", async () => {
    await expect(
      captureFencedLegacySnapshots(
        [participant("model", "payload", stableWatermark(), [])],
        { token: "looks-real", fencedAt: "2026-07-28T12:00:00.000Z" } as never,
        () => "2026-07-28T12:01:00.000Z",
      ),
    ).rejects.toThrowError("MODEL_LEGACY_EXPORT_FENCE_NOT_VERIFIED");

    expect(() => signedFence(["model"], "2026-07-28T12:16:00.000Z")).toThrowError(
      "MODEL_LEGACY_EXPORT_FENCE_EXPIRED",
    );

    const wrong = signedFence(["model"], "2026-07-28T12:01:00.000Z", {
      digest: "c".repeat(64),
      latestUpdatedAt: "2026-07-28T11:59:00.000Z",
    });
    await expect(
      captureFencedLegacySnapshots(
        [participant("model", "payload", stableWatermark(), [])],
        wrong,
        () => "2026-07-28T12:01:00.000Z",
      ),
    ).rejects.toThrowError("MODEL_LEGACY_EXPORT_FENCE_VIOLATED:model");
  });
});

function signedFence(
  sourceNames: readonly string[],
  now = "2026-07-28T12:01:00.000Z",
  watermark = stableWatermark(),
) {
  const claims = {
    schemaVersion: 1 as const,
    leaseId: "018f9f4e-7b2d-7c31-8a10-89abcdef0123",
    issuer: "legacy-model-control-owner",
    purpose: "model_control_export" as const,
    issuedAt: "2026-07-28T11:58:00.000Z",
    fencedAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-07-28T12:15:00.000Z",
    sources: sourceNames.map((name) => ({
      name,
      databaseIdentity: `db.internal:3306/kokoro_${name}`,
      watermark,
    })),
  };
  const signature = sign(null, legacyExportFenceSigningPayload(claims), privateKey).toString(
    "base64",
  );
  return verifyLegacyExportFenceAttestation(
    { claims, signature, keyVersion: "owner-key-1" },
    {
      publicKey,
      expectedIssuer: "legacy-model-control-owner",
      expectedSources: claims.sources.map(({ name, databaseIdentity }) => ({
        name,
        databaseIdentity,
      })),
      now,
    },
  );
}

function stableWatermark() {
  return { digest: "a".repeat(64), latestUpdatedAt: "2026-07-28T11:59:00.000Z" };
}

function participant<Payload>(
  name: string,
  payload: Payload,
  watermarks: ReturnType<typeof stableWatermark> | readonly ReturnType<typeof stableWatermark>[],
  events: string[],
): LegacySnapshotParticipant<Payload> {
  const values = Array.isArray(watermarks) ? [...watermarks] : [watermarks];
  let current = 0;
  return {
    name,
    readCurrentWatermark: async () => {
      events.push(`${name}:current`);
      return values[Math.min(current++, values.length - 1)]!;
    },
    beginConsistentSnapshot: async () => {
      events.push(`${name}:begin`);
    },
    readSnapshotWatermark: async () => {
      events.push(`${name}:snapshot-watermark`);
      return values[Math.min(current++, values.length - 1)]!;
    },
    readPayload: async () => {
      events.push(`${name}:payload`);
      return payload;
    },
    commit: async () => {
      events.push(`${name}:commit`);
    },
    rollback: async () => {
      events.push(`${name}:rollback`);
    },
  };
}
