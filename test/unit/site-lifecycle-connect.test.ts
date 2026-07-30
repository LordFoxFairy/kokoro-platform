import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from "../../src/interfaces/connect/generated-site-lifecycle/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
} from "../../src/interfaces/connect/generated-site-lifecycle/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  ActivationFactsSchema,
  ApproveAndActivateEffectSchema,
  ApproveAndActivateRequestSchema,
  RequestActivationApprovalEffectSchema,
  RequestActivationApprovalRequestSchema,
  SiteActivationState,
  SiteEffectApprovalState,
} from "../../src/interfaces/connect/generated-site-lifecycle/kokoro/platform/site/v1/site_lifecycle_pb.js";
import {
  approveAndActivateRequestDigest,
  requestActivationApprovalRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-site-lifecycle/command-envelope-digest.js";
import { createSiteLifecycleConnectService } from
  "../../src/modules/site/interfaces/connect/site-lifecycle-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";

const transport = {} as HandlerContext;
const verifiedContext = Object.freeze({}) as VerifiedRequestSecurityContext;

describe("Site lifecycle Connect provider", () => {
  it("binds the maker approval to the exact Site activation facts and reason", async () => {
    const requestApproval = vi.fn(async () => ({
      approvalRef: "approval:1", state: "pending" as const,
      recordedAt: "2026-07-29T12:00:00.000Z",
      expiresAt: "2026-07-29T12:10:00.000Z",
    }));
    const service = createSiteLifecycleConnectService({
      owner: { requestActivationApproval: requestApproval, approveAndActivate: vi.fn() },
      resolver: resolver(),
    });
    const request = approvalRequest();

    await expect(service.requestActivationApproval(request, transport)).resolves.toMatchObject({
      approvalRef: "approval:1", state: SiteEffectApprovalState.PENDING,
    });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001",
      approvalRef: "approval:1", siteRef: "site:alpha", candidateReleaseRef: "release:7",
      expectedActiveReleaseRef: null, audience: "kokoro-session",
      sessionContractRevision: "session-v7", reason: "launch approved",
    }), verifiedContext);
  });

  it("passes the canonical command identity to the owner and rejects digest drift", async () => {
    const activate = vi.fn(async () => ({ attemptRef: "attempt:1", state: "preparing",
      replayed: false, recordedAt: "2026-07-29T12:00:00.000Z" }));
    const service = createSiteLifecycleConnectService({
      owner: { requestActivationApproval: vi.fn(), approveAndActivate: activate },
      resolver: resolver(),
    });
    const request = activationRequest();

    await expect(service.approveAndActivate(request, transport)).resolves.toMatchObject({
      activationAttemptRef: "attempt:1", state: SiteActivationState.PREPARING, replayed: false,
    });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001", approvalRef: "approval:1",
      attemptRef: "attempt:1", siteRef: "site:alpha", reason: "launch approved",
    }), verifiedContext);

    request.context!.command!.requestDigest = "f".repeat(64);
    await expect(service.approveAndActivate(request, transport))
      .rejects.toThrow("SITE_LIFECYCLE_COMMAND_DIGEST_INVALID");
    expect(activate).toHaveBeenCalledTimes(1);
  });
});

function resolver() {
  return {
    resolveSiteCommand: vi.fn(async () => ({ context: verifiedContext, axes })),
  };
}

const authenticatedAt = timestampFromDate(new Date("2026-07-29T12:00:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-29T12:01:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web-admin", audience: "platform-admin",
  actorRef: "operator:7", operatorGeneration: 2n, operatorSessionRef: "session:9",
  environment: "production", region: "us-east-1", managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["oidc", "webauthn"]), authenticatedAt, stepUpAt,
  operatorAttestationRef: "attestation:7", operatorAttestationDigest: "a".repeat(64),
});

function context() {
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "0".repeat(64),
    }),
    actorRef: axes.actorRef, operatorGeneration: axes.operatorGeneration,
    operatorSessionRef: axes.operatorSessionRef, environment: axes.environment, region: axes.region,
    managedDeviceRef: axes.managedDeviceRef, assuranceLevel: axes.assuranceLevel,
    factorClasses: [...axes.factorClasses], authenticatedAt, stepUpAt,
    operatorAttestationRef: axes.operatorAttestationRef,
    operatorAttestationDigest: axes.operatorAttestationDigest,
    securityEpochs: create(SecurityEpochsSchema, {
      operatorSecurityEpoch: 1n, sessionEpoch: 1n, restrictionEpoch: 1n,
      policyEpoch: 1n, siteSecurityEpoch: 1n,
    }),
    scope: create(OperatorScopeSchema, {
      kind: { case: "site", value: create(SiteScopeSchema, {
        siteIds: ["site:alpha"], environment: axes.environment, region: axes.region,
      }) },
    }),
  });
}

function facts() {
  return create(ActivationFactsSchema, {
    candidateReleaseRef: "release:7", audience: "kokoro-session",
    sessionContractRevision: "session-v7", reason: "launch approved",
  });
}

function approvalRequest() {
  const claimed = context();
  const effect = create(RequestActivationApprovalEffectSchema, {
    approvalRef: "approval:1", activation: facts(),
  });
  claimed.command!.requestDigest = requestActivationApprovalRequestDigest(
    claimed, "site:alpha", effect, axes,
  );
  return create(RequestActivationApprovalRequestSchema, {
    context: claimed, siteId: "site:alpha", effect,
  });
}

function activationRequest() {
  const claimed = context();
  const effect = create(ApproveAndActivateEffectSchema, {
    approvalRef: "approval:1", activationAttemptRef: "attempt:1", activation: facts(),
  });
  claimed.command!.requestDigest = approveAndActivateRequestDigest(
    claimed, "site:alpha", effect, axes,
  );
  return create(ApproveAndActivateRequestSchema, {
    context: claimed, siteId: "site:alpha", effect,
  });
}
