import { verify, type KeyObject } from "node:crypto";
import {
  parseRequestSecurityContext,
  verifyRequestSecurityContext,
  type RequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../shared/security-context/request-security-context.js";

export type CoreBootstrapAdminAttestationEnvelope = Readonly<{
  context: RequestSecurityContext;
  signature: string;
  keyVersion: string;
}>;

export type CoreBootstrapAdminAttestationBundle = Readonly<{
  version: 1;
  attestations: readonly Readonly<{
    operation: string;
    envelope: CoreBootstrapAdminAttestationEnvelope;
  }>[];
}>;

/** Domain-separated canonical payload accepted by the one-shot bootstrap verifier. */
export function coreBootstrapAdminAttestationPayload(
  context: RequestSecurityContext,
): Uint8Array {
  return Buffer.concat([
    Buffer.from("kokoro.core-single-site-bootstrap.admin-attestation.v1\0", "utf8"),
    Buffer.from(stableJson(context), "utf8"),
  ]);
}

export function parseCoreBootstrapAdminAttestationBundle(
  input: unknown,
): CoreBootstrapAdminAttestationBundle {
  const root = record(input);
  exact(root, ["version", "attestations"]);
  if (root.version !== 1 || !Array.isArray(root.attestations) ||
      root.attestations.length < 1 || root.attestations.length > 64) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BUNDLE_INVALID");
  }
  const attestations = root.attestations.map((candidate) => {
    const item = record(candidate);
    exact(item, ["operation", "envelope"]);
    const envelope = record(item.envelope);
    exact(envelope, ["context", "signature", "keyVersion"]);
    if (typeof item.operation !== "string" || !operation(item.operation) ||
        typeof envelope.signature !== "string" ||
        typeof envelope.keyVersion !== "string") {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BUNDLE_INVALID");
    }
    return Object.freeze({
      operation: item.operation,
      envelope: Object.freeze({
        context: parseRequestSecurityContext(envelope.context),
        signature: envelope.signature,
        keyVersion: envelope.keyVersion,
      }),
    });
  });
  if (new Set(attestations.map(({ operation: value }) => value)).size !== attestations.length) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BUNDLE_INVALID");
  }
  return Object.freeze({ version: 1, attestations: Object.freeze(attestations) });
}

export async function verifyCoreBootstrapAdminAttestation(input: Readonly<{
  envelope: CoreBootstrapAdminAttestationEnvelope;
  publicKey: KeyObject;
  operation: string;
  operatorRef: string;
  now: string;
  audience: string;
  environment: string;
  region: string;
  allowedOperations?: readonly string[];
  target?: Readonly<{
    siteId: string | null;
    purpose: string;
    scopes: readonly string[];
  }>;
}>): Promise<VerifiedRequestSecurityContext> {
  const { context } = input.envelope;
  const expectedAllowed = input.allowedOperations ?? [input.operation];
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
      context.actor.subjectId !== input.operatorRef ||
      !sameStrings(context.trustedCaller.allowedOperations, expectedAllowed) ||
      !context.trustedCaller.allowedOperations.includes(input.operation) ||
      (input.target !== undefined && (context.target.siteId !== input.target.siteId ||
        context.target.purpose !== input.target.purpose ||
        !sameStrings(context.target.scopes, input.target.scopes))) ||
      input.envelope.keyVersion.length < 1 || input.envelope.keyVersion.length > 64 ||
      input.publicKey.type !== "public" || input.publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BINDING_INVALID");
  }
  let signature: Buffer;
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(input.envelope.signature)) throw new Error();
    signature = Buffer.from(input.envelope.signature, "base64");
    if (signature.toString("base64") !== input.envelope.signature) throw new Error();
  }
  catch { throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_INVALID"); }
  if (signature.byteLength !== 64 ||
      !verify(null, coreBootstrapAdminAttestationPayload(context), input.publicKey, signature)) {
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BUNDLE_INVALID");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(value).some((key) => !names.includes(key))) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ATTESTATION_BUNDLE_INVALID");
  }
}

function operation(value: string): boolean {
  return /^[a-z][a-z0-9.-]{2,127}$/u.test(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort()
    .every((value, index) => value === [...right].sort()[index]);
}
