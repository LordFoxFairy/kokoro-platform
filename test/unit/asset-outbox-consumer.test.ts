import { describe, expect, it, vi } from "vitest";
import { digestAssetCommand } from
  "../../src/modules/asset/application/asset-digest.js";
import {
  AssetOutboxConsumer,
  type AssetEffectEventQueue,
  type AssetEffectServices,
} from "../../src/modules/asset/infrastructure/postgres/asset-outbox-consumer.js";
import type { ClaimedOutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";

describe("AssetOutboxConsumer", () => {
  it("dispatches and acknowledges all four durable Asset effect commands", async () => {
    const calls: string[] = [];
    const events = [
      event("asset.upload.completion.requested", {
        kind: "asset_upload_completion_requested_v1", siteRef: "site_01",
        intentRef: "intent_01", sessionRef: "session_01", expectedVersion: "2",
      }, "session_01", 1),
      event("asset.scan.requested", {
        kind: "asset_scan_requested_v1", siteRef: "site_01",
        candidateRef: "candidate_01", expectedVersion: "3",
      }, "candidate_01", 2),
      event("asset.blob.promotion.requested", {
        kind: "asset_blob_promotion_requested_v1", siteRef: "site_01",
        promotionRef: "promotion_01", expectedVersion: "4",
      }, "promotion_01", 3),
      event("asset.object.cleanup.requested", {
        kind: "asset_object_cleanup_requested_v1", siteRef: "site_01",
        cleanupRef: "cleanup_01", expectedVersion: "5",
      }, "cleanup_01", 4),
    ];
    const consumer = new AssetOutboxConsumer(queue(events, calls), services(calls));

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls[0]).toBe("claim");
    expect(calls.slice(1, 5)).toEqual([
      "completion:session_01:2",
      "scan:candidate_01:3",
      "promotion:promotion_01:4",
      "cleanup:cleanup_01:5",
    ]);
    expect(new Set(calls.slice(5))).toEqual(new Set([
      "ack:event_01", "ack:event_02", "ack:event_03", "ack:event_04",
    ]));
  });

  it("retries a temporary domain disposition with bounded exponential backoff", async () => {
    const calls: string[] = [];
    const servicesFixture = services(calls);
    servicesFixture.scan.execute = vi.fn(async () => ({
      disposition: "retry" as const,
      code: "ASSET_MALWARE_SCAN_UNAVAILABLE",
    }));
    const consumer = new AssetOutboxConsumer(queue([event("asset.scan.requested", {
      kind: "asset_scan_requested_v1", siteRef: "site_01",
      candidateRef: "candidate_01", expectedVersion: "3",
    }, "candidate_01", 1, 3)], calls), servicesFixture, {
      now: () => "2026-07-30T10:00:00.000Z", baseRetryMs: 1_000,
    });

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls).toContain(
      "retry:event_01:ASSET_MALWARE_SCAN_UNAVAILABLE:2026-07-30T10:00:04.000Z:12",
    );
  });

  it("dead-letters malformed or tampered commands instead of invoking an effect", async () => {
    const calls: string[] = [];
    const tampered = {
      ...event("asset.scan.requested", {
        kind: "asset_scan_requested_v1", siteRef: "site_01",
        candidateRef: "candidate_01", expectedVersion: "3",
      }, "candidate_01", 1),
      payloadDigest: "f".repeat(64),
    };
    const consumer = new AssetOutboxConsumer(queue([tampered], calls), services(calls));

    await consumer.runOneCycle({ signal: new AbortController().signal });

    expect(calls).toEqual(["claim", "retry:event_01:ASSET_OUTBOX_EVENT_INVALID:null:12"]);
  });

  it("stops new claims and returns an in-flight lease during process drain", async () => {
    const calls: string[] = [];
    let finish: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    const servicesFixture = services(calls);
    servicesFixture.scan.execute = vi.fn(async () => {
      calls.push("scan-started");
      await completion;
      return { disposition: "promotion_pending" as const, assetVersionRef: "version_01" };
    });
    const queueFixture = queue([
      event("asset.scan.requested", {
        kind: "asset_scan_requested_v1", siteRef: "site_01",
        candidateRef: "candidate_01", expectedVersion: "3",
      }, "candidate_01", 1),
      event("asset.scan.requested", {
        kind: "asset_scan_requested_v1", siteRef: "site_01",
        candidateRef: "candidate_02", expectedVersion: "3",
      }, "candidate_02", 2),
    ], calls);
    const consumer = new AssetOutboxConsumer(queueFixture, servicesFixture);
    const controller = new AbortController();
    const cycle = consumer.runOneCycle({ signal: controller.signal });
    await vi.waitFor(() => expect(calls).toContain("scan-started"));

    await consumer.stopClaiming();
    controller.abort(new Error("draining"));
    await consumer.returnLeases("shutdown");
    expect(calls).toContain("release:event_01:shutdown");
    expect(calls).toContain("release:event_02:shutdown");
    finish?.();
    await expect(cycle).rejects.toThrow("draining");
    await consumer.runOneCycle({ signal: new AbortController().signal });
    expect(calls.filter((value) => value === "claim")).toHaveLength(1);
  });

  it("renews an in-flight lease before a slow security scan can be reclaimed", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      let finish: (() => void) | undefined;
      const completion = new Promise<void>((resolve) => { finish = resolve; });
      const servicesFixture = services(calls);
      servicesFixture.scan.execute = vi.fn(async () => {
        calls.push("scan-started");
        await completion;
        return { disposition: "promotion_pending" as const, assetVersionRef: "version_01" };
      });
      const consumer = new AssetOutboxConsumer(queue([
        event("asset.scan.requested", {
          kind: "asset_scan_requested_v1", siteRef: "site_01",
          candidateRef: "candidate_01", expectedVersion: "3",
        }, "candidate_01", 1),
        event("asset.scan.requested", {
          kind: "asset_scan_requested_v1", siteRef: "site_01",
          candidateRef: "candidate_02", expectedVersion: "3",
        }, "candidate_02", 2),
      ], calls), servicesFixture, { leaseHeartbeatMs: 1_000 });

      const cycle = consumer.runOneCycle({ signal: new AbortController().signal });
      await vi.waitFor(() => expect(calls).toContain("scan-started"));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toContain("renew:event_01");
      expect(calls).toContain("renew:event_02");
      finish?.();
      await cycle;
      expect(calls.indexOf("renew:event_01")).toBeLessThan(calls.indexOf("ack:event_01"));
    } finally {
      vi.useRealTimers();
    }
  });
});

function services(calls: string[]): AssetEffectServices {
  return {
    completion: { execute: vi.fn(async (input) => {
      calls.push(`completion:${input.sessionRef}:${input.expectedVersion}`);
      return { disposition: "accepted" as const, candidateRef: "candidate_01" };
    }) },
    scan: { execute: vi.fn(async (input) => {
      calls.push(`scan:${input.candidateRef}:${input.expectedVersion}`);
      return { disposition: "promotion_pending" as const, assetVersionRef: "version_01" };
    }) },
    promotion: { execute: vi.fn(async (input) => {
      calls.push(`promotion:${input.promotionRef}:${input.expectedVersion}`);
      return { disposition: "ready" as const, assetRef: "asset_01", assetVersionRef: "version_01" };
    }) },
    cleanup: { execute: vi.fn(async (input) => {
      calls.push(`cleanup:${input.cleanupRef}:${input.expectedVersion}`);
      return { disposition: "completed" as const };
    }) },
  };
}

function queue(events: ClaimedOutboxEvent[], calls: string[]): AssetEffectEventQueue {
  let claimed = false;
  return {
    claim: async () => { calls.push("claim"); claimed = true; return events; },
    renew: async (eventId) => { calls.push(`renew:${eventId}`); },
    ack: async (eventId) => { calls.push(`ack:${eventId}`); },
    retry: async (input) => {
      calls.push(`retry:${input.eventId}:${input.errorCode}:${input.retryAt}:${input.maxAttempts}`);
    },
    release: async (eventId, _leaseToken, reason) => {
      if (claimed) calls.push(`release:${eventId}:${reason}`);
    },
  };
}

function event(
  eventType: string,
  payload: Record<string, string>,
  aggregateId: string,
  sequence: number,
  attempt = 1,
): ClaimedOutboxEvent {
  return {
    eventId: `event_0${sequence}`, owner: "asset", eventType, aggregateId, payload,
    payloadDigest: digestAssetCommand(payload), correlationId: "correlation_01",
    causationId: "request_01", leaseToken: `lease_0${sequence}`, attempt,
  };
}
