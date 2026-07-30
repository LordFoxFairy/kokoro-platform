import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from "../../src/interfaces/connect/generated-site-provisioning/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  GlobalScopeSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
} from "../../src/interfaces/connect/generated-site-provisioning/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  RegisterSiteEffectSchema,
  RegisterSiteRequestSchema,
} from "../../src/interfaces/connect/generated-site-provisioning/kokoro/platform/site/v1/site_provisioning_pb.js";
import {
  registerSiteRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-site-provisioning/command-envelope-digest.js";
import { createSiteProvisioningConnectService } from
  "../../src/modules/site/interfaces/connect/site-provisioning-service.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";

describe("SiteProvisioning Connect provider", () => {
  it("returns a typed conflict for command-id drift on the same idempotency key", async () => {
    const context = create(AuthenticatedOperatorCommandContextSchema, {
      command: create(CommandIdentityV2Schema, {
        commandId: "018f1212-1212-7212-8212-121212121212",
        idempotencyKey: "site-register-identity-0001",
        digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
        requestDigest: "0".repeat(64),
      }),
      actorRef: axes.actorRef, operatorGeneration: axes.operatorGeneration,
      operatorSessionRef: axes.operatorSessionRef, environment: axes.environment, region: axes.region,
      managedDeviceRef: axes.managedDeviceRef, assuranceLevel: axes.assuranceLevel,
      factorClasses: [...axes.factorClasses], authenticatedAt: axes.authenticatedAt,
      stepUpAt: axes.stepUpAt, operatorAttestationRef: axes.operatorAttestationRef,
      operatorAttestationDigest: axes.operatorAttestationDigest,
      securityEpochs: create(SecurityEpochsSchema, {
        operatorSecurityEpoch: 1n, sessionEpoch: 1n, restrictionEpoch: 1n, policyEpoch: 1n,
      }),
      scope: create(OperatorScopeSchema, { kind: { case: "global", value: create(GlobalScopeSchema, {
        grantId: "grant:global", environment: "production", region: "us-east-1",
      }) } }),
    });
    const effect = create(RegisterSiteEffectSchema, {
      siteKey: "alpha-site", projectBindingRef: "project-binding:alpha",
      repositoryRef: "github:example/alpha", providerNamespace: "vercel",
      providerProjectRef: "project:alpha", workloadIdentityRef: "spiffe://kokoro/site/alpha",
    });
    context.command!.requestDigest = registerSiteRequestDigest(context, "site:alpha", effect, axes);
    const service = createSiteProvisioningConnectService({
      owner: {
        registerSite: vi.fn(async () => { throw new Error("COMMAND_IDENTITY_CONFLICT"); }),
        publishRelease: vi.fn(async () => { throw new Error("unexpected"); }),
      },
      resolver: { resolveSiteProvisioningCommand: vi.fn(async () => ({
        context: Object.freeze({ environment: "production" }) as VerifiedRequestSecurityContext, axes,
      })) },
      receipts: { read: vi.fn(async () => "2026-07-30T12:00:00.000Z") },
    });
    const request = create(RegisterSiteRequestSchema, { context, siteId: "site:alpha", effect });

    const error = await Promise.resolve(service.registerSite(request, {} as HandlerContext))
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConnectError);
    expect(ConnectError.from(error).code).toBe(Code.AlreadyExists);
    expect(ConnectError.from(error).rawMessage).toBe("command identity conflict");
  });
});

const authenticatedAt = timestampFromDate(new Date("2026-07-30T11:50:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-30T11:59:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = Object.freeze({
  workloadIdentityRef: "spiffe://kokoro/web-admin", audience: "platform-admin",
  actorRef: "operator:1", operatorGeneration: 1n, operatorSessionRef: "session:1",
  environment: "production", region: "us-east-1", managedDeviceRef: "device:1",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: Object.freeze(["oidc", "webauthn"]), authenticatedAt, stepUpAt,
  operatorAttestationRef: "attestation:1", operatorAttestationDigest: "a".repeat(64),
});
