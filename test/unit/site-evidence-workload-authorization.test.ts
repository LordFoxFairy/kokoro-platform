import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
} from "../../src/generated/proto/kokoro/common/v2/command_envelope_pb.js";
import {
  ImmutableContractRevisionBindingSchema,
} from "../../src/generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  AttestedReleaseEvidenceContextSchema,
  ReleaseEvidenceProducerRole,
  WorkloadAuthorizationState,
} from "../../src/generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import {
  PostgresSiteEvidenceWorkloadAuthorizationResolver,
  siteEvidenceWorkloadAuthorizationLiveRead,
} from "../../src/modules/site/infrastructure/postgres/site-evidence-workload-authorization-resolver.js";
import {
  SITE_EVIDENCE_ADMISSION_AUDIENCE,
  SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
  type VerifiedSiteEvidencePeer,
} from "../../src/modules/site/infrastructure/security/site-evidence-peer-registry.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const digest = `sha256:${"a".repeat(64)}`;
const peer: VerifiedSiteEvidencePeer = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/site-evidence-attestor",
  siteProjectBindingRef: "site-project-binding.alpha",
  siteRef: "site:alpha",
  environment: "production",
  region: "us-east-1",
  audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
  operation: SITE_EVIDENCE_ADMISSION_RPC_OPERATION,
  producerIdentityRef: "producer.web-attestor",
  producerRegistration: { ref: "producer-registration.alpha", revision: 2n, digest },
  producerRole: "web-artifact-provenance-attestor",
  workloadAttestation: { ref: "workload-attestation.alpha", revision: 4n, digest },
});

describe("PostgresSiteEvidenceWorkloadAuthorizationResolver", () => {
  it("creates a verified workload context from the exact live project binding", async () => {
    const statements: string[] = [];
    const resolver = new PostgresSiteEvidenceWorkloadAuthorizationResolver({
      database: database("active", statements),
      peer: () => peer,
    });
    const claimed = context();

    const resolved = await resolver.resolve(claimed, {} as HandlerContext, {
      siteRef: peer.siteRef,
      resourceRefs: ["candidate.alpha", "provenance.alpha"],
    });

    expect(resolved.context).toMatchObject({
      trustedCaller: {
        kind: "platform_worker",
        workloadIdentityId: peer.workloadIdentityRef,
        bindingEpoch: "7",
        allowedOperations: ["site.release-evidence.publish"],
      },
      actor: { kind: "workload", subjectId: peer.workloadIdentityRef },
      target: { siteId: peer.siteRef },
      audience: SITE_EVIDENCE_ADMISSION_AUDIENCE,
      environment: "production",
      region: "us-east-1",
    });
    expect(resolved.axes).toMatchObject({
      workloadIdentityRef: peer.workloadIdentityRef,
      siteId: peer.siteRef,
      workloadAuthorizationEpoch: 7n,
      workloadRevocationEpoch: 0n,
      workloadAuthorizationState: WorkloadAuthorizationState.ACTIVE,
      producerIdentityRef: peer.producerIdentityRef,
      producerRole: ReleaseEvidenceProducerRole.WEB_ARTIFACT_PROVENANCE_ATTESTOR,
    });
    expect(statements[0]).toContain("set_config('app.site_project_binding_ref',$5,true)");
    expect(statements[0]).toContain("set_config('app.workload_binding_epoch',$6,true)");
  });

  it("rejects claimed producer drift before opening the live authorization read", async () => {
    const internalTransaction = vi.fn();
    const resolver = new PostgresSiteEvidenceWorkloadAuthorizationResolver({
      database: { internalTransaction } as never,
      peer: () => peer,
    });
    const claimed = context();
    claimed.producerIdentityRef = "producer.unregistered";

    await expect(resolver.resolve(claimed, {} as HandlerContext, {
      siteRef: peer.siteRef,
      resourceRefs: ["candidate.alpha"],
    })).rejects.toThrow("SITE_EVIDENCE_PEER_CONTEXT_MISMATCH");
    expect(internalTransaction).not.toHaveBeenCalled();
  });

  it("rejects a revoked live project binding", async () => {
    const resolver = new PostgresSiteEvidenceWorkloadAuthorizationResolver({
      database: database("revoked"),
      peer: () => peer,
    });

    await expect(resolver.resolve(context(), {} as HandlerContext, {
      siteRef: peer.siteRef,
      resourceRefs: ["candidate.alpha"],
    })).rejects.toThrow("SITE_EVIDENCE_WORKLOAD_AUTHORIZATION_INACTIVE");
  });
});

function context() {
  const liveRead = siteEvidenceWorkloadAuthorizationLiveRead({
    bindingRef: peer.siteProjectBindingRef,
    bindingEpoch: 7n,
    workloadIdentityRef: peer.workloadIdentityRef,
    siteRef: peer.siteRef,
    environment: peer.environment,
    region: peer.region,
    state: "active",
  });
  return create(AttestedReleaseEvidenceContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "site-evidence-idempotency-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "b".repeat(64),
    }),
    workloadIdentityRef: peer.workloadIdentityRef,
    audience: peer.audience,
    environment: peer.environment,
    region: peer.region,
    producerIdentityRef: peer.producerIdentityRef,
    producerRegistration: create(ImmutableContractRevisionBindingSchema, peer.producerRegistration),
    producerRole: ReleaseEvidenceProducerRole.WEB_ARTIFACT_PROVENANCE_ATTESTOR,
    workloadAttestation: create(ImmutableContractRevisionBindingSchema, peer.workloadAttestation),
    workloadAuthorizationEpoch: 7n,
    workloadRevocationEpoch: 0n,
    workloadAuthorizationState: WorkloadAuthorizationState.ACTIVE,
    workloadAuthorizationLiveRead: create(ImmutableContractRevisionBindingSchema, liveRead),
    workloadAuthorizationObservedAt: timestampFromDate(new Date("2026-08-02T11:59:55.000Z")),
    workloadAuthorizationValidUntil: timestampFromDate(new Date("2026-08-02T12:00:05.000Z")),
  });
}

function database(state: "active" | "revoked", statements: string[] = []) {
  return {
    async internalTransaction(operation: string, work: (transaction: never) => Promise<unknown>) {
      expect(operation).toBe("site.evidence.authorize");
      const lease = issuePlatformTransaction({
        query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
          statements.push(statement);
          return (statement.includes("set_config") ? [] : [{
            bindingRef: peer.siteProjectBindingRef,
            bindingEpoch: 7n,
            state,
            authoritativeNow: "2026-08-02T12:00:00.000Z",
          }]) as unknown as readonly Row[];
        },
        execute: async () => 0,
      });
      try {
        return await work(lease.transaction as never);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  } as never;
}
