import type { Http2ServerRequest } from "node:http2";
import { TLSSocket } from "node:tls";
import { isDeploymentEnvironment, type DeploymentEnvironment } from
  "../../../../shared/deployment-environment.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

export const SITE_EVIDENCE_ADMISSION_AUDIENCE =
  "kokoro.site-release-evidence-admission.v1";
export const SITE_EVIDENCE_ADMISSION_RPC_OPERATION =
  "kokoro.platform.site.v1.SiteEvidenceAdmissionService/RecordReleaseEvidence";

export interface VerifiedSiteEvidencePeer {
  readonly workloadIdentityRef: string;
  readonly siteProjectBindingRef: string;
  readonly siteRef: string;
  readonly environment: DeploymentEnvironment;
  readonly region: string;
  readonly audience: typeof SITE_EVIDENCE_ADMISSION_AUDIENCE;
  readonly operation: typeof SITE_EVIDENCE_ADMISSION_RPC_OPERATION;
  readonly producerIdentityRef: string;
  readonly producerRegistration: ImmutableRevisionBinding;
  readonly producerRole: "web-artifact-provenance-attestor";
  readonly workloadAttestation: ImmutableRevisionBinding;
}

interface RegisteredSiteEvidencePeer extends VerifiedSiteEvidencePeer {
  readonly fingerprint256: string;
  readonly sanUri: string;
}

export interface SiteEvidencePeerCertificate {
  readonly authorized: boolean;
  readonly authorizationError: Error | string | null;
  readonly fingerprint256: string;
  readonly sanUris: readonly string[];
  readonly validFrom: string;
  readonly validTo: string;
}

export class SiteEvidencePeerRegistry {
  readonly #peers: readonly RegisteredSiteEvidencePeer[];

  private constructor(peers: readonly RegisteredSiteEvidencePeer[]) {
    this.#peers = peers;
  }

  static parse(input: unknown): SiteEvidencePeerRegistry {
    const root = record(input);
    exact(root, ["version", "peers"]);
    if (root.version !== 1 || !Array.isArray(root.peers) ||
        root.peers.length < 1 || root.peers.length > 64) invalid();
    const fingerprints = new Set<string>();
    const identities = new Set<string>();
    const peers = root.peers.map((value): RegisteredSiteEvidencePeer => {
      const peer = record(value);
      exact(peer, [
        "fingerprint256", "sanUri", "siteProjectBindingRef", "siteRef", "environment",
        "region", "audience", "operation", "producerIdentityRef", "producerRegistration",
        "producerRole", "workloadAttestation",
      ]);
      const fingerprint256 = fingerprint(peer.fingerprint256);
      const sanUri = spiffe(peer.sanUri);
      if (fingerprints.has(fingerprint256) || identities.has(sanUri)) invalid();
      fingerprints.add(fingerprint256);
      identities.add(sanUri);
      const environment = text(peer.environment, 32);
      if (!isDeploymentEnvironment(environment) ||
          peer.audience !== SITE_EVIDENCE_ADMISSION_AUDIENCE ||
          peer.operation !== SITE_EVIDENCE_ADMISSION_RPC_OPERATION ||
          peer.producerRole !== "web-artifact-provenance-attestor") invalid();
      return Object.freeze({
        fingerprint256,
        sanUri,
        workloadIdentityRef: sanUri,
        siteProjectBindingRef: text(peer.siteProjectBindingRef, 256),
        siteRef: text(peer.siteRef, 128),
        environment,
        region: text(peer.region, 128),
        audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
        operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
        producerIdentityRef: text(peer.producerIdentityRef, 256),
        producerRegistration: binding(peer.producerRegistration),
        producerRole: "web-artifact-provenance-attestor",
        workloadAttestation: binding(peer.workloadAttestation),
      });
    });
    return new SiteEvidencePeerRegistry(Object.freeze(peers));
  }

  authenticateCertificate(
    certificate: SiteEvidencePeerCertificate,
    now: Date = new Date(),
  ): VerifiedSiteEvidencePeer | null {
    const current = now.valueOf();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!certificate.authorized || certificate.authorizationError !== null ||
        !Number.isFinite(current) || !Number.isFinite(validFrom) || !Number.isFinite(validTo) ||
        validFrom > current || validTo <= current) return null;
    const peer = this.#peers.find((candidate) =>
      candidate.fingerprint256 === certificate.fingerprint256 &&
      certificate.sanUris.includes(candidate.sanUri));
    if (peer === undefined) return null;
    return Object.freeze({
      workloadIdentityRef: peer.workloadIdentityRef,
      siteProjectBindingRef: peer.siteProjectBindingRef,
      siteRef: peer.siteRef,
      environment: peer.environment,
      region: peer.region,
      audience: peer.audience,
      operation: peer.operation,
      producerIdentityRef: peer.producerIdentityRef,
      producerRegistration: peer.producerRegistration,
      producerRole: peer.producerRole,
      workloadAttestation: peer.workloadAttestation,
    });
  }
}

export function authenticateSiteEvidencePeer(
  request: Http2ServerRequest,
  registry: SiteEvidencePeerRegistry,
  now: Date = new Date(),
): VerifiedSiteEvidencePeer | null {
  const socket = request.socket;
  if (!(socket instanceof TLSSocket)) return null;
  const certificate = socket.getPeerCertificate();
  const subjectAlternativeName = certificate.subjectaltname;
  return registry.authenticateCertificate({
    authorized: socket.authorized,
    authorizationError: socket.authorizationError,
    fingerprint256: certificate.fingerprint256 ?? "",
    sanUris: subjectAlternativeName === undefined ? [] : subjectAlternativeName.split(/,\s*/u)
      .filter((entry) => entry.startsWith("URI:"))
      .map((entry) => entry.slice(4)),
    validFrom: certificate.valid_from,
    validTo: certificate.valid_to,
  }, now);
}

function binding(input: unknown): ImmutableRevisionBinding {
  const value = record(input);
  exact(value, ["ref", "revision", "digest"]);
  const revision = decimal(value.revision);
  return Object.freeze({
    ref: text(value.ref, 256),
    revision,
    digest: digest(value.digest),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) invalid();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 3 || value.length > maximum ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })) invalid();
  return value;
}

function spiffe(value: unknown): string {
  const parsed = text(value, 256);
  if (!/^spiffe:\/\/[a-z0-9.-]+\/[A-Za-z0-9._~!$&'()*+;=:@%/-]+$/u.test(parsed)) invalid();
  return parsed;
}

function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(value)) invalid();
  return value;
}

function decimal(value: unknown): bigint {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value)) invalid();
  const parsed = BigInt(value);
  if (parsed > 18_446_744_073_709_551_615n) invalid();
  return parsed;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid();
  return value;
}

function invalid(): never {
  throw new Error("PLATFORM_SITE_EVIDENCE_MTLS_PEERS_INVALID");
}
