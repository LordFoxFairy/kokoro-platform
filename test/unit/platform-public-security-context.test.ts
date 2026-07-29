import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPlatformPublicRequestSecurityContext } from "../../src/interfaces/http/platform-public.js";
import { ProductWorkloadRegistry } from "../../src/modules/authorization/infrastructure/transport/product-workload-registry.js";
import type { ProductWorkloadIdentity } from "../../src/modules/authorization/domain/session-access-grant.js";

describe("Platform Public mutation evidence", () => {
  it("adds only the verified CSRF digest and never the raw token", async () => {
    const token = "raw-token-that-is-long-enough-to-verify-123456";
    const csrfEvidenceDigest = createHash("sha256").update(token, "utf8").digest("hex");
    const { registry, workload } = fixture(csrfEvidenceDigest);
    const csrfEvidence = registry.verifyCsrfEvidence(workload, token);
    expect(csrfEvidence).not.toBeNull();
    const context = await buildPlatformPublicRequestSecurityContext({ workload, session: null, operation: "exchangeProductContext", requestId: "req", correlationId: "corr", now: "2026-07-28T00:00:00.000Z", projectRef: null, registry, csrfEvidence: csrfEvidence! });
    expect(context.evidence).toContainEqual({ kind: "csrf_verification", evidenceId: csrfEvidenceDigest, issuer: "kokoro-platform-public" });
    expect(JSON.stringify(context)).not.toContain(token);
  });

  it("does not manufacture CSRF evidence for a read context", async () => {
    const { registry, workload } = fixture("c".repeat(64));
    const context = await buildPlatformPublicRequestSecurityContext({ workload, session: null, operation: "getPersonalContext", requestId: "req", correlationId: "corr", now: "2026-07-28T00:00:00.000Z", projectRef: null, registry, csrfEvidence: null });
    expect(context.evidence.some((item) => item.kind === "csrf_verification")).toBe(false);
  });

  it("rejects a forged raw digest or object without registry provenance", async () => {
    const { registry, workload } = fixture("c".repeat(64));
    const base = { workload, session: null, operation: "exchangeProductContext" as const, requestId: "req", correlationId: "corr", now: "2026-07-28T00:00:00.000Z", projectRef: null, registry };
    await expect(buildPlatformPublicRequestSecurityContext({ ...base, csrfEvidence: "c".repeat(64) as never })).rejects.toThrow("WORKLOAD_NOT_AUTHORIZED");
    await expect(buildPlatformPublicRequestSecurityContext({ ...base, csrfEvidence: { workloadIdentityId: workload.workloadIdentityId, digest: "c".repeat(64) } as never })).rejects.toThrow("WORKLOAD_NOT_AUTHORIZED");
  });
});

function fixture(csrfSha256: string) {
  const workload: ProductWorkloadIdentity = { certificateSha256: "a".repeat(64), workloadIdentityId: "site-web-1", siteProjectBindingRef: "binding-1", deploymentRef: "deploy-1", siteRef: "site-1", siteReleaseRef: "release-1", webArtifactDigest: "b".repeat(64), sessionContractRevision: "v1", environment: "production", region: "us-east-1", audience: "platform-public", allowedOperations: ["exchangeProductContext", "getPersonalContext"], bindingEpoch: "2", siteSecurityEpoch: "7", policyEpoch: "6", csrfSha256 };
  const registry = ProductWorkloadRegistry.parse({ version: 1, registryRevision: "r1", registrations: [workload] });
  return { registry, workload };
}
