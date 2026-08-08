import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from "../../src/generated/proto/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
} from "../../src/generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  CandidateAuthorityBindingSchema,
  ImmutableContractRevisionBindingSchema,
} from "../../src/generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  IssueWebBuildIntentEffectSchema,
  IssueWebBuildIntentRequestSchema,
} from "../../src/generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import {
  issueWebBuildIntentRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/generated/contracts/platform-site-publication@v1/digest.js";
import { createSitePublicationConnectService } from
  "../../src/modules/site/interfaces/connect/site-publication-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";

const transport = {} as HandlerContext;
const verifiedContext = Object.freeze({}) as VerifiedRequestSecurityContext;
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

describe("Site publication Connect provider", () => {
  it("delegates Platform-owned WebBuildIntent issuance without a caller-authored binding", async () => {
    const issueWebBuildIntent = vi.fn(async () => ({
      binding: { ref: "web-build-intent.alpha", revision: 7n, digest: digestC },
      siteRef: "site:alpha",
      state: "published" as const,
      replayed: false,
    }));
    const service = createSitePublicationConnectService({
      owner: {
        authorizeCandidate: vi.fn(),
        revokeCandidate: vi.fn(),
        publishNode: vi.fn(),
        publishRelease: vi.fn(),
        issueWebBuildIntent,
      } as never,
      resolver: {
        resolveSitePublicationCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn(async () => "2026-08-01T00:00:00.000Z") },
    });
    const request = intentRequest();

    await expect(service.issueWebBuildIntent(request, transport)).resolves.toMatchObject({
      webBuildIntent: { ref: "web-build-intent.alpha", revision: 7n, digest: digestC },
      replayed: false,
      receipt: { operation: "site.web-build-intent.publish" },
    });
    expect(issueWebBuildIntent).toHaveBeenCalledWith({
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001",
      siteRef: "site:alpha",
      candidate: {
        ref: "candidate:alpha",
        version: 7n,
        authorizationEpoch: 3n,
        digest: digestA,
      },
      expectedSurfaceInventory: {
        ref: "surface-inventory.alpha",
        revision: 7n,
        digest: digestB,
      },
      expectedWebBuildMaterialBundle: {
        ref: "web-build-material.alpha",
        revision: 4n,
        digest: digestC,
      },
      reason: "issue the authorized web build input",
    }, verifiedContext);
  });

  it("rejects WebBuildIntent issuance when the canonical request digest drifts", async () => {
    const issueWebBuildIntent = vi.fn();
    const service = createSitePublicationConnectService({
      owner: {
        authorizeCandidate: vi.fn(),
        revokeCandidate: vi.fn(),
        publishNode: vi.fn(),
        publishRelease: vi.fn(),
        issueWebBuildIntent,
      } as never,
      resolver: {
        resolveSitePublicationCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
      },
      receipts: { read: vi.fn() },
    });
    const request = intentRequest();
    request.context!.command!.requestDigest = "f".repeat(64);

    await expect(service.issueWebBuildIntent(request, transport))
      .rejects.toThrow("SITE_PUBLICATION_REQUEST_DIGEST_MISMATCH");
    expect(issueWebBuildIntent).not.toHaveBeenCalled();
  });
});

const authenticatedAt = timestampFromDate(new Date("2026-08-01T00:00:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-08-01T00:01:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web-admin",
  audience: "platform-admin",
  actorRef: "operator:7",
  operatorGeneration: 2n,
  operatorSessionRef: "session:9",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["oidc", "webauthn"]),
  authenticatedAt,
  stepUpAt,
  operatorAttestationRef: "attestation:7",
  operatorAttestationDigest: "d".repeat(64),
});

function context() {
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "0".repeat(64),
    }),
    actorRef: axes.actorRef,
    operatorGeneration: axes.operatorGeneration,
    operatorSessionRef: axes.operatorSessionRef,
    environment: axes.environment,
    region: axes.region,
    managedDeviceRef: axes.managedDeviceRef,
    assuranceLevel: axes.assuranceLevel,
    factorClasses: [...axes.factorClasses],
    authenticatedAt,
    stepUpAt,
    operatorAttestationRef: axes.operatorAttestationRef,
    operatorAttestationDigest: axes.operatorAttestationDigest,
    securityEpochs: create(SecurityEpochsSchema, {
      operatorSecurityEpoch: 1n,
      sessionEpoch: 1n,
      restrictionEpoch: 1n,
      policyEpoch: 1n,
      siteSecurityEpoch: 1n,
    }),
    scope: create(OperatorScopeSchema, {
      kind: {
        case: "site",
        value: create(SiteScopeSchema, {
          siteIds: ["site:alpha"],
          environment: axes.environment,
          region: axes.region,
        }),
      },
    }),
  });
}

function intentRequest() {
  const claimed = context();
  const effect = create(IssueWebBuildIntentEffectSchema, {
    candidate: create(CandidateAuthorityBindingSchema, {
      candidateRef: "candidate:alpha",
      candidateVersion: 7n,
      candidateAuthorizationEpoch: 3n,
      candidateDigest: digestA,
    }),
    expectedSurfaceInventory: create(ImmutableContractRevisionBindingSchema, {
      ref: "surface-inventory.alpha",
      revision: 7n,
      digest: digestB,
    }),
    expectedWebBuildMaterialBundle: create(ImmutableContractRevisionBindingSchema, {
      ref: "web-build-material.alpha",
      revision: 4n,
      digest: digestC,
    }),
    reason: "issue the authorized web build input",
  });
  claimed.command!.requestDigest = issueWebBuildIntentRequestDigest(
    claimed,
    "site:alpha",
    effect,
    axes,
  );
  return create(IssueWebBuildIntentRequestSchema, {
    context: claimed,
    siteId: "site:alpha",
    effect,
  });
}
