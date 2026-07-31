import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("src/modules/media/application/image-operation-worker.ts", "utf8");
const repository = readFileSync(
  "src/modules/media/infrastructure/postgres/media-image-worker-repository.ts",
  "utf8",
);

describe("Media worker effect ownership boundary", () => {
  it("uses only the typed Model Gateway image-effect lifecycle", () => {
    expect(worker).toContain("interface MediaImageEffectPort");
    for (const operation of ["create", "recoverByCommand", "getByCommand", "getEvidence", "requestCancel"]) {
      expect(worker).toMatch(new RegExp(`\\b${operation}\\(`, "u"));
    }
    expect(worker).not.toContain("ImageProviderAdapter");
    expect(worker).not.toContain("createOrRecover");
    expect(worker).not.toMatch(/from ["'][^"']*(?:openai|anthropic|litellm|provider)[^"']*["']/u);
  });

  it("freezes effect budget and model authorization before Gateway Create", () => {
    expect(worker).toContain("effectBudgetCommitRef");
    expect(worker).toContain("modelOptionAuthorizationHandle");
    expect(worker).toContain("callerAccessHandle");
    expect(worker).toContain("operationInputRevisionDigest");
    expect(worker).toContain("effectBudgetCommitDigest");
    expect(worker).toContain("trustEffectAllowReceiptDigest");
    expect(worker).toContain("stableOutputSlotRef");
    expect(worker).not.toContain("settleChild");
    expect(worker).toMatch(/effect\.create\(\{[\s\S]+callerAccessHandle:[\s\S]+modelOptionAuthorizationHandle:[\s\S]+effectBudgetCommitRef:/u);
  });

  it("never persists raw image bytes in the Media owner journal", () => {
    expect(repository).not.toContain("bytesBase64");
    expect(repository).not.toContain("ImageProviderOutcome");
    expect(worker).not.toContain("sourceHandle");
    expect(worker).not.toContain("providerEffectRef");
    expect(worker).not.toContain("gatewayOwnerReceiptRef");
    expect(worker).toContain("afterEvidenceSequence");
    expect(worker).toContain("nextEvidenceSequence");
    expect(worker).toContain("outputAccessCommandRef");
    expect(worker).toContain("outputEvidenceDigest");
    expect(repository).toContain("CapabilityEnvelope");
    expect(repository).toContain("capabilityOpener");
  });

  it("recovers started and outcome-unknown effects instead of invoking Create again", () => {
    expect(repository).toContain('kind: "recover"');
    expect(repository).toContain('if (row.created) return Object.freeze({ kind: "create" as const })');
    expect(repository).toContain('row.ownerResult === null');
    expect(repository).not.toContain('kind: "invoke"');
  });

  it("does not auto-Attach DNS or mint cross-owner receipt digests locally", () => {
    expect(worker).toContain("MEDIA_NEXT_ATTEMPT_AUTHORIZATION_REQUIRED");
    expect(worker).not.toContain("this.#dependencies.effect.attach");
    expect(worker).not.toContain("kokoro.platform.media-terminal");
    expect(worker).not.toContain("kokoro.platform.artifact-finalization");
    expect(worker).toContain("MediaImageReceiptCanonicalizerPort");
  });
});
