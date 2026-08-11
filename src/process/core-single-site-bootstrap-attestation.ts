import { verify, type KeyObject } from "node:crypto";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../shared/security-context/request-security-context.js";

export type CoreBootstrapAdminAttestationEnvelope = Readonly<{
  context: RequestSecurityContext;
  signature: string;
  keyVersion: string;
}>;

export async function verifyCoreBootstrapAdminAttestation(input: Readonly<{
  envelope: CoreBootstrapAdminAttestationEnvelope;
  publicKey: KeyObject;
  operation: string;
  operatorRef: string;
  now: string;
  audience: string;
  environment: string;
  region: string;
}>): Promise<VerifiedRequestSecurityContext> {
  const { context } = input.envelope;
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
      context.actor.subjectId !== input.operatorRef || !context.trustedCaller.allowedOperations.includes(input.operation) ||
      input.envelope.keyVersion.length < 1 || input.envelope.keyVersion.length > 64) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BINDING_INVALID");
  }
  const bytes = Buffer.from(JSON.stringify(context));
  let signature: Buffer;
  try { signature = Buffer.from(input.envelope.signature, "base64"); }
  catch { throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_INVALID"); }
  if (signature.byteLength !== 64 || !verify(null, bytes, input.publicKey, signature)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_INVALID");
  }
  return verifyRequestSecurityContext(context, {
    now: input.now, operation: input.operation, expectedAudience: input.audience,
    expectedEnvironment: input.environment, expectedRegion: input.region,
    callerVerifier: { async verify(candidate) {
      return { workloadIdentityId: candidate.trustedCaller.workloadIdentityId,
        kind: candidate.trustedCaller.kind, audience: candidate.trustedCaller.audience,
        environment: candidate.trustedCaller.environment, region: candidate.trustedCaller.region,
        allowedOperations: candidate.trustedCaller.allowedOperations,
        siteId: candidate.trustedCaller.siteId ?? null,
        bindingEpoch: candidate.trustedCaller.bindingEpoch, issuedAt: candidate.trustedCaller.issuedAt,
        expiresAt: candidate.trustedCaller.expiresAt, issuer: candidate.evidence[0]?.issuer ?? "",
        keyVersion: input.envelope.keyVersion };
    } },
  });
}
