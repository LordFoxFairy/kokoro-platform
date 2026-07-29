import { describe, expect, it } from "vitest";
import {
  SiteDeploymentProviderRegistry,
  SiteProviderEffectError,
  type SiteDeploymentProvider,
} from "../../src/modules/site/application/contracts/site-deployment-provider.js";
import type {
  SiteRuntimeStateStore,
  SiteRuntimeStep,
} from "../../src/modules/site/application/contracts/site-runtime-state.js";
import { SiteRuntimeDispatcher } from "../../src/modules/site/application/services/site-runtime-dispatcher.js";

describe("SiteRuntimeDispatcher", () => {
  it("uses only the exact configured namespace and drives promotion plus old-deployment drain", async () => {
    const calls: string[] = [];
    const promotion = promotionStep("promote");
    const drain = drainStep();
    const state: SiteRuntimeStateStore = {
      prepareActivation: async () => promotion,
      acceptPromotion: async (_attemptRef, observation) => {
        calls.push(`accept:${observation.payloadDigest}`);
        return drain;
      },
      acceptActivationDrain: async (_attemptRef, observation) => {
        calls.push(`drain:${observation.payloadDigest}`);
        return { kind: "complete" };
      },
      prepareTrafficStop: async () => ({ kind: "complete" }),
      acceptTrafficStop: async () => ({ kind: "complete" }),
      recordActivationFailure: async () => ({ kind: "complete" }),
      recordTrafficStopFailure: async () => ({ kind: "complete" }),
    };
    const provider = fakeProvider(calls);
    const dispatcher = new SiteRuntimeDispatcher(state, new SiteDeploymentProviderRegistry([provider]));
    await dispatcher.runActivation("activation_01", new AbortController().signal);
    expect(calls).toEqual(["promote:promotion-op", `accept:${"a".repeat(64)}`,
      "stop:drain-op", `drain:${"b".repeat(64)}`]);
  });

  it("fails closed instead of falling back to a different provider", async () => {
    const state = stateReturning({ ...promotionStep("promote"), providerNamespace: "cloudflare" });
    const dispatcher = new SiteRuntimeDispatcher(
      state,
      new SiteDeploymentProviderRegistry([fakeProvider([])]),
    );
    await expect(dispatcher.runActivation("activation_01", new AbortController().signal))
      .rejects.toThrow("SITE_PROVIDER_NOT_CONFIGURED:cloudflare");
  });

  it("persists an ambiguous RPC effect before scheduling reconciliation", async () => {
    const failures: string[] = [];
    const state = stateReturning(promotionStep("promote"), failures);
    const provider: SiteDeploymentProvider = {
      ...fakeProvider([]),
      promote: async () => { throw new SiteProviderEffectError("unknown", "PROVIDER_TIMEOUT"); },
    };
    const dispatcher = new SiteRuntimeDispatcher(state, new SiteDeploymentProviderRegistry([provider]));
    await expect(dispatcher.runActivation("activation_01", new AbortController().signal))
      .rejects.toThrow("PROVIDER_TIMEOUT");
    expect(failures).toEqual(["activation:unknown:PROVIDER_TIMEOUT"]);
  });
});

function promotionStep(
  kind: "promote" | "observe_promotion",
): Extract<SiteRuntimeStep, { kind: "promote" | "observe_promotion" }> {
  return { kind, providerNamespace: "vercel", command: {
    operationKey: "promotion-op", siteRef: "site_01", providerProjectRef: "project_01",
    releaseRef: "release_02", webArtifactDigest: "1".repeat(64),
    releaseManifestDigest: "2".repeat(64), certificationDigest: "3".repeat(64),
    environment: "production", region: "us-east-1",
  } };
}
function drainStep(): SiteRuntimeStep {
  return { kind: "stop_activation_drain", providerNamespace: "vercel",
    webArtifactDigest: "4".repeat(64), command: {
    operationKey: "drain-op", siteRef: "site_01", providerProjectRef: "project_01",
    deploymentRef: "deployment_01", environment: "production", region: "us-east-1",
  } };
}
function stateReturning(step: SiteRuntimeStep, failures: string[] = []): SiteRuntimeStateStore {
  return { prepareActivation: async () => step, acceptPromotion: async () => ({ kind: "complete" }),
    acceptActivationDrain: async () => ({ kind: "complete" }),
    prepareTrafficStop: async () => ({ kind: "complete" }),
    acceptTrafficStop: async () => ({ kind: "complete" }),
    recordActivationFailure: async (_ref, outcome, code) => {
      failures.push(`activation:${outcome}:${code}`); return step;
    },
    recordTrafficStopFailure: async (_ref, outcome, code) => {
      failures.push(`traffic:${outcome}:${code}`); return step;
    } };
}
function fakeProvider(calls: string[]): SiteDeploymentProvider {
  return {
    namespace: "vercel",
    promote: async (command) => { calls.push(`promote:${command.operationKey}`); return {
      status: "ready", deploymentRef: "deployment_02", observedAt: "2026-07-29T13:01:00Z",
      payloadDigest: "a".repeat(64),
    }; },
    observePromotion: async () => { throw new Error("unexpected"); },
    stopTraffic: async (command) => { calls.push(`stop:${command.operationKey}`); return {
      status: "stopped", observedAt: "2026-07-29T13:02:00Z", payloadDigest: "b".repeat(64),
    }; },
    observeTrafficStop: async (command) => { calls.push(`observe-stop:${command.operationKey}`); return {
      status: "stopped", observedAt: "2026-07-29T13:02:00Z", payloadDigest: "b".repeat(64),
    }; },
  };
}
