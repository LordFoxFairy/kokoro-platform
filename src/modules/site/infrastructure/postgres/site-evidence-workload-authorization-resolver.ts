import { createHash } from "node:crypto";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ReleaseEvidenceProducerRole, WorkloadAuthorizationState, type AttestedReleaseEvidenceContext } from
  "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import type { VerifiedReleaseEvidenceWorkloadAxes } from
  "../../../../generated/contracts/platform-site-evidence-admission@v1/digest.js";
import type { PlatformTransactionalDatabaseClient } from
  "../../../../infrastructure/postgres/client.js";
import { canonicalDigest } from "../../../product-catalog/domain/canonical-product-document.js";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
} from "../../../../shared/security-context/request-security-context.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { SiteEvidenceAdmissionResolver } from
  "../../interfaces/connect/site-evidence-admission-service.js";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";
import {
  SITE_EVIDENCE_ADMISSION_AUDIENCE,
  SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
  type VerifiedSiteEvidencePeer,
} from "../security/site-evidence-peer-registry.js";

const DOMAIN_OPERATION = "site.release-evidence.publish";
const AUTHORIZATION_WINDOW_MS = 30_000;
const CONTEXT_ISSUER = "kokoro:site-evidence-mtls-peer-registry";

interface SiteEvidenceWorkloadAuthorizationRow extends Record<string, unknown> {
  readonly bindingRef: string;
  readonly bindingEpoch: bigint;
  readonly state: "active" | "revoked";
  readonly authoritativeNow: Date | string;
}

export class PostgresSiteEvidenceWorkloadAuthorizationResolver
implements SiteEvidenceAdmissionResolver {
  constructor(private readonly dependencies: Readonly<{
    database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
    peer: () => VerifiedSiteEvidencePeer | undefined;
  }>) {}

  async resolve(
    claimed: AttestedReleaseEvidenceContext,
    _transport: Parameters<SiteEvidenceAdmissionResolver["resolve"]>[1],
    request: Parameters<SiteEvidenceAdmissionResolver["resolve"]>[2],
  ) {
    const peer = this.dependencies.peer();
    if (peer === undefined) throw new Error("SITE_EVIDENCE_VERIFIED_PEER_REQUIRED");
    assertPeerContext(claimed, request.siteRef, request.resourceRefs, peer);
    return this.dependencies.database.internalTransaction("site.evidence.authorize", async (transaction) => {
      const sql = resolvePlatformTransaction(transaction);
      await sql.query(
        `SELECT set_config('app.site_id',$1,true),set_config('app.environment',$2,true),
                set_config('app.region',$3,true),set_config('app.workload_identity_ref',$4,true),
                set_config('app.site_project_binding_ref',$5,true),
                set_config('app.workload_binding_epoch',$6,true),
                set_config('app.actor_kind','workload',true)`,
        [peer.siteRef, peer.environment, peer.region, peer.workloadIdentityRef,
          peer.siteProjectBindingRef, claimed.workloadAuthorizationEpoch.toString()],
      );
      const rows = await sql.query<SiteEvidenceWorkloadAuthorizationRow>(
        `SELECT binding_ref AS "bindingRef",binding_epoch AS "bindingEpoch",state,
                clock_timestamp() AS "authoritativeNow"
         FROM platform.site_project_binding
         WHERE binding_ref=$1 AND workload_identity_id=$2 AND site_ref=$3
           AND environment=$4 AND region=$5`,
        [peer.siteProjectBindingRef, peer.workloadIdentityRef, peer.siteRef,
          peer.environment, peer.region],
      );
      if (rows.length !== 1) throw new Error("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_NOT_FOUND");
      const row = rows[0]!;
      if (row.state !== "active") {
        throw new Error("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_INACTIVE");
      }
      const liveRead = siteEvidenceWorkloadAuthorizationLiveRead({
        bindingRef: row.bindingRef,
        bindingEpoch: row.bindingEpoch,
        workloadIdentityRef: peer.workloadIdentityRef,
        siteRef: peer.siteRef,
        environment: peer.environment,
        region: peer.region,
        state: row.state,
      });
      const now = canonicalDate(row.authoritativeNow, "SITE_EVIDENCE_AUTHORIZATION_TIME_INVALID");
      const observedAt = protobufDate(claimed.workloadAuthorizationObservedAt,
        "SITE_EVIDENCE_AUTHORIZATION_OBSERVED_AT_REQUIRED");
      const validUntil = protobufDate(claimed.workloadAuthorizationValidUntil,
        "SITE_EVIDENCE_AUTHORIZATION_VALID_UNTIL_REQUIRED");
      if (observedAt.valueOf() > now.valueOf() || validUntil.valueOf() <= now.valueOf() ||
          validUntil.valueOf() - observedAt.valueOf() > AUTHORIZATION_WINDOW_MS ||
          now.valueOf() - observedAt.valueOf() > AUTHORIZATION_WINDOW_MS) {
        throw new Error("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_STALE");
      }
      if (claimed.workloadAuthorizationEpoch !== row.bindingEpoch ||
          claimed.workloadRevocationEpoch !== 0n ||
          claimed.workloadAuthorizationState !== WorkloadAuthorizationState.ACTIVE ||
          !sameBinding(claimed.workloadAuthorizationLiveRead, liveRead)) {
        throw new Error("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_MISMATCH");
      }
      const issuedAt = now.toISOString();
      const expiresAt = validUntil.toISOString();
      const caller = Object.freeze({
        workloadIdentityId: peer.workloadIdentityRef,
        kind: "platform_worker" as const,
        audience: peer.audience,
        environment: peer.environment,
        region: peer.region,
        allowedOperations: Object.freeze([DOMAIN_OPERATION]),
        siteId: peer.siteRef,
        bindingEpoch: row.bindingEpoch.toString(),
        issuedAt,
        expiresAt,
        issuer: CONTEXT_ISSUER,
        keyVersion: row.bindingEpoch.toString(),
      });
      const securityContext: RequestSecurityContext = {
        requestId: commandId(claimed),
        correlationId: commandId(claimed),
        trustedCaller: {
          kind: caller.kind,
          workloadIdentityId: caller.workloadIdentityId,
          siteId: peer.siteRef,
          environment: caller.environment,
          region: caller.region,
          audience: caller.audience,
          allowedOperations: caller.allowedOperations,
          bindingEpoch: caller.bindingEpoch,
          issuedAt,
          expiresAt,
        },
        actor: {
          kind: "workload",
          subjectId: peer.workloadIdentityRef,
          subjectGeneration: row.bindingEpoch.toString(),
          environment: peer.environment,
          region: peer.region,
        },
        delegatedGrant: null,
        target: {
          siteId: peer.siteRef,
          workspaceId: null,
          projectId: null,
          purpose: DOMAIN_OPERATION,
          scopes: Object.freeze([DOMAIN_OPERATION]),
        },
        audience: peer.audience,
        environment: peer.environment,
        region: peer.region,
        evidence: Object.freeze([
          Object.freeze({ kind: "mtls-workload", evidenceId: peer.workloadIdentityRef,
            issuer: CONTEXT_ISSUER }),
          Object.freeze({ kind: "workload-attestation", evidenceId: peer.workloadAttestation.ref,
            issuer: CONTEXT_ISSUER }),
        ]),
        policyEpoch: row.bindingEpoch.toString(),
        issuedAt,
        expiresAt,
      };
      const context = await verifyRequestSecurityContext(securityContext, {
        now: issuedAt,
        operation: DOMAIN_OPERATION,
        expectedAudience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
        expectedEnvironment: peer.environment,
        expectedRegion: peer.region,
        callerVerifier: { verify: async () => caller },
      });
      const axes: VerifiedReleaseEvidenceWorkloadAxes = Object.freeze({
        workloadIdentityRef: peer.workloadIdentityRef,
        audience: peer.audience,
        environment: peer.environment,
        region: peer.region,
        siteId: peer.siteRef,
        producerIdentityRef: peer.producerIdentityRef,
        producerRegistrationRef: peer.producerRegistration.ref,
        producerRegistrationRevision: peer.producerRegistration.revision,
        producerRegistrationDigest: peer.producerRegistration.digest,
        producerRole: ReleaseEvidenceProducerRole.WEB_ARTIFACT_PROVENANCE_ATTESTOR,
        workloadAttestationRef: peer.workloadAttestation.ref,
        workloadAttestationRevision: peer.workloadAttestation.revision,
        workloadAttestationDigest: peer.workloadAttestation.digest,
        workloadAuthorizationEpoch: row.bindingEpoch,
        workloadRevocationEpoch: 0n,
        workloadAuthorizationState: WorkloadAuthorizationState.ACTIVE,
        workloadAuthorizationLiveReadRef: liveRead.ref,
        workloadAuthorizationLiveReadRevision: liveRead.revision,
        workloadAuthorizationLiveReadDigest: liveRead.digest,
        workloadAuthorizationObservedAt: claimed.workloadAuthorizationObservedAt!,
        workloadAuthorizationValidUntil: claimed.workloadAuthorizationValidUntil!,
        authoritativeNow: timestampFromDate(now),
      });
      return Object.freeze({ context, axes });
    });
  }
}

export function siteEvidenceWorkloadAuthorizationLiveRead(input: Readonly<{
  bindingRef: string;
  bindingEpoch: bigint;
  workloadIdentityRef: string;
  siteRef: string;
  environment: string;
  region: string;
  state: "active" | "revoked";
}>): ImmutableRevisionBinding {
  const document = Object.freeze({
    contract: "kokoro.site-evidence-workload-authorization-live-read.v1",
    bindingRef: input.bindingRef,
    bindingEpoch: input.bindingEpoch.toString(),
    workloadIdentityRef: input.workloadIdentityRef,
    siteRef: input.siteRef,
    environment: input.environment,
    region: input.region,
    state: input.state,
  });
  return Object.freeze({
    ref: `site-workload-authorization.${createHash("sha256").update(input.bindingRef).digest("hex")}`,
    revision: input.bindingEpoch,
    digest: canonicalDigest(document),
  });
}

function assertPeerContext(
  claimed: AttestedReleaseEvidenceContext,
  siteRef: string,
  resourceRefs: readonly string[],
  peer: VerifiedSiteEvidencePeer,
): void {
  if (peer.operation !== SITE_EVIDENCE_ADMISSION_RPC_OPERATION || siteRef !== peer.siteRef ||
      claimed.workloadIdentityRef !== peer.workloadIdentityRef || claimed.audience !== peer.audience ||
      claimed.environment !== peer.environment || claimed.region !== peer.region ||
      claimed.producerIdentityRef !== peer.producerIdentityRef ||
      claimed.producerRole !== ReleaseEvidenceProducerRole.WEB_ARTIFACT_PROVENANCE_ATTESTOR ||
      !sameBinding(claimed.producerRegistration, peer.producerRegistration) ||
      !sameBinding(claimed.workloadAttestation, peer.workloadAttestation) ||
      resourceRefs.length < 1 || resourceRefs.length > 16 ||
      new Set(resourceRefs).size !== resourceRefs.length ||
      resourceRefs.some((value) => value.length < 3 || value.length > 256)) {
    throw new Error("SITE_EVIDENCE_PEER_CONTEXT_MISMATCH");
  }
}

function sameBinding(
  actual: Readonly<{ ref: string; revision: bigint; digest: string }> | undefined,
  expected: ImmutableRevisionBinding,
): boolean {
  return actual !== undefined && actual.ref === expected.ref && actual.revision === expected.revision &&
    actual.digest === expected.digest;
}

function protobufDate(
  value: Parameters<typeof timestampDate>[0] | undefined,
  code: string,
): Date {
  if (value === undefined) throw new Error(code);
  return canonicalDate(timestampDate(value), code);
}

function canonicalDate(value: Date | string, code: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(code);
  return date;
}

function commandId(context: AttestedReleaseEvidenceContext): string {
  const value = context.command?.commandId;
  if (value === undefined || value.length < 3 || value.length > 128) {
    throw new Error("SITE_EVIDENCE_COMMAND_REQUIRED");
  }
  return value;
}
