import type { CapabilityProjectionDelivery } from
  "../domain/capability-publication-repository.js";

export class CapabilityProjectionDeliveryError extends Error {
  constructor(readonly disposition: "retry" | "rejected", readonly stableCode: string) {
    super(stableCode);
    this.name = "CapabilityProjectionDeliveryError";
  }
}

export interface PlatformCapabilityProjectionClient {
  project(delivery: CapabilityProjectionDelivery, signal: AbortSignal): Promise<void>;
}
