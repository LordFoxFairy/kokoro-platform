import { describe, expect, it } from "vitest";
import {
  captureFencedLegacySnapshots,
  sameLegacyDatabaseIdentity,
  type LegacySnapshotParticipant,
} from "../../src/modules/model-control/migration/legacy-export-snapshot.js";

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
    const result = await captureFencedLegacySnapshots(
      [model, site],
      { token: "change-freeze-42", fencedAt: "2026-07-28T12:00:00.000Z" },
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
    await expect(
      captureFencedLegacySnapshots(
        [changed],
        { token: "change-freeze-42", fencedAt: "2026-07-28T12:00:00.000Z" },
        () => "2026-07-28T12:01:00.000Z",
      ),
    ).rejects.toThrowError("MODEL_LEGACY_EXPORT_FENCE_VIOLATED:model");
    expect(events).toContain("model:rollback");
    expect(events).not.toContain("model:payload");
    expect(events).not.toContain("model:commit");
  });
});

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
