import { randomUUID } from "node:crypto";
import type { CapabilityPublicationRepository } from
  "../domain/capability-publication-repository.js";
import {
  CapabilityProjectionDeliveryError,
  type PlatformCapabilityProjectionClient,
} from "../infrastructure/connect/platform-capability-projection-client.js";

export class CapabilityProjectionWorker {
  readonly #clock: () => Date;
  readonly #leaseId: () => string;

  constructor(private readonly input: Readonly<{
    repository: CapabilityPublicationRepository;
    client: PlatformCapabilityProjectionClient;
    clock?: () => Date;
    leaseId?: () => string;
    leaseMs?: number;
    requestTimeoutMs?: number;
  }>) {
    this.#clock = input.clock ?? (() => new Date());
    this.#leaseId = input.leaseId ?? randomUUID;
  }

  async tick(signal: AbortSignal): Promise<"idle" | "committed" | "deferred" | "rejected"> {
    if (signal.aborted) return "idle";
    const now = this.#now();
    const leaseId = this.#leaseId();
    const delivery = await this.input.repository.claimProjection({
      leaseId,
      now,
      leaseUntil: new Date(Date.parse(now) + (this.input.leaseMs ?? 15_000)).toISOString(),
    });
    if (delivery === null) return "idle";
    const request = new AbortController();
    const aborted = () => request.abort(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => request.abort(new Error("PROJECTION_TIMEOUT")),
      this.input.requestTimeoutMs ?? 5_000);
    timer.unref();
    try {
      await this.input.client.project(delivery, request.signal);
      await this.input.repository.completeProjection({
        siteId: delivery.publication.siteId,
        siteReleaseRef: delivery.publication.siteReleaseRef,
        leaseId,
        projectedAt: this.#now(),
      });
      return "committed";
    } catch (error) {
      const mapped = error instanceof CapabilityProjectionDeliveryError
        ? error
        : new CapabilityProjectionDeliveryError("retry", "PROJECTION_OUTCOME_UNKNOWN");
      const rejected = mapped.disposition === "rejected";
      await this.input.repository.deferProjection({
        siteId: delivery.publication.siteId,
        siteReleaseRef: delivery.publication.siteReleaseRef,
        leaseId,
        state: rejected ? "rejected" : "outcome_unknown",
        errorCode: mapped.stableCode,
        ...(rejected ? {} : { nextAttemptAt: new Date(
          Date.parse(this.#now()) + retryDelayMs(delivery.attempt),
        ).toISOString() }),
      });
      return rejected ? "rejected" : "deferred";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }

  #now(): string {
    const value = this.#clock().getTime();
    if (!Number.isFinite(value)) throw new Error("HUB_CAPABILITY_PROJECTION_CLOCK_INVALID");
    return new Date(value).toISOString();
  }
}

function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 1_000;
  return Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
}
