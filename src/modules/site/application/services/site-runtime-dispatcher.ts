import { createHash } from "node:crypto";
import {
  SiteProviderEffectError,
  type SiteDeploymentProviderRegistry,
} from "../contracts/site-deployment-provider.js";
import type { SiteRuntimeStateStore, SiteRuntimeStep } from "../contracts/site-runtime-state.js";

export class SiteRuntimePendingError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class SiteRuntimeDispatcher {
  constructor(
    private readonly state: SiteRuntimeStateStore,
    private readonly providers: SiteDeploymentProviderRegistry,
  ) {}

  runActivation(attemptRef: string, signal: AbortSignal): Promise<void> {
    return this.run(this.state.prepareActivation(attemptRef), attemptRef, signal);
  }

  runTrafficStop(attemptRef: string, signal: AbortSignal): Promise<void> {
    return this.run(this.state.prepareTrafficStop(attemptRef), attemptRef, signal);
  }

  private async run(initial: Promise<SiteRuntimeStep>, attemptRef: string, signal: AbortSignal): Promise<void> {
    let step = await initial;
    for (let transitions = 0; transitions < 4; transitions += 1) {
      signal.throwIfAborted();
      if (step.kind === "complete") return;
      const current = step;
      const provider = this.providers.require(current.providerNamespace);
      if (current.kind === "promote" || current.kind === "observe_promotion") {
        let observation;
        try {
          observation = current.kind === "promote"
            ? await provider.promote(current.command, signal)
            : await provider.observePromotion(current.command, signal);
        } catch (error) {
          if (error instanceof SiteProviderEffectError) {
            await this.state.recordActivationFailure(attemptRef, error.outcome, error.code);
          }
          throw error;
        }
        step = await this.state.acceptPromotion(attemptRef, observation);
        if (observation.status !== "ready" && step.kind !== "complete") {
          throw new SiteRuntimePendingError(`SITE_PROMOTION_${observation.status.toUpperCase()}`);
        }
        continue;
      }
      const trafficStep = current as Extract<SiteRuntimeStep, { command: { deploymentRef: string } }>;
      let observation;
      try {
        observation = trafficStep.kind === "stop_site_traffic" || trafficStep.kind === "stop_activation_drain"
          ? await provider.stopTraffic(trafficStep.command, signal)
          : await provider.observeTrafficStop(trafficStep.command, signal);
      } catch (error) {
        if (error instanceof SiteProviderEffectError) {
          if (trafficStep.kind !== "stop_activation_drain") {
            await this.state.recordTrafficStopFailure(attemptRef, error.outcome, error.code);
          }
        }
        throw error;
      }
      step = trafficStep.kind === "stop_activation_drain"
        ? await this.state.acceptActivationDrain(attemptRef, observation)
        : await this.state.acceptTrafficStop(attemptRef, observation);
      if (observation.status !== "stopped" && step.kind !== "complete") {
        throw new SiteRuntimePendingError(`SITE_TRAFFIC_STOP_${observation.status.toUpperCase()}`);
      }
    }
    throw new SiteRuntimePendingError("SITE_RUNTIME_TRANSITION_LIMIT");
  }
}

export function siteProviderOperationKey(
  action: "promote" | "activation-drain" | "traffic-stop",
  attemptRef: string,
): string {
  return `site-${action}-${createHash("sha256").update("kokoro-site-provider-v1\0")
    .update(action).update("\0").update(attemptRef).digest("hex")}`;
}
