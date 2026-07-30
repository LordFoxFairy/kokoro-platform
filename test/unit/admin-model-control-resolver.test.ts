import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  OperatorAssuranceLevel,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/common/v2/command_envelope_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  GlobalScopeSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
  SiteScopeSchema,
} from
  "../../src/interfaces/connect/generated-model-control/kokoro/platform/admin/v2/admin_shared_pb.js";
import type { AuthenticatedAdminSession } from
  "../../src/modules/admin/domain/admin-authorization.js";
import {
  AdminControlPlaneResolver,
  operatorAttestation,
} from
  "../../src/modules/admin/infrastructure/security/admin-control-plane-resolver.js";

describe("Admin ModelControl resolver", () => {
  it("builds global administration and exact-Site release contexts from authenticated grants", async () => {
    const resolver = new AdminControlPlaneResolver({
      peer: () => peer,
      authenticator: { authenticate: vi.fn(async () => authenticated) } as never,
      clock: () => new Date(now),
    });

    const global = await resolver.resolveModelControlCommand(
      commandContext("global"), transport,
      {
        operation: "model.option.materialize",
        siteRef: null,
        resourceRefs: ["inventory:a"],
        scope: "global",
        purpose: "model_control_administration",
        contextScopes: ["model:option:materialize"],
      },
    );
    expect(global.context.target).toEqual({
      siteId: null,
      workspaceId: null,
      projectId: null,
      purpose: "model_control_administration",
      scopes: ["model:option:materialize"],
    });

    const site = await resolver.resolveModelControlCommand(
      commandContext("site"), transport,
      {
        operation: "model.site-release-catalog.publish",
        siteRef: "site:alpha",
        resourceRefs: ["site:alpha", "release:7"],
        scope: "site",
        purpose: "site_release",
        contextScopes: ["model:site-release:publish"],
      },
    );
    expect(site.context.target).toEqual({
      siteId: "site:alpha",
      workspaceId: null,
      projectId: null,
      purpose: "site_release",
      scopes: ["model:site-release:publish"],
    });
  });

  it("rejects a global grant for an exact-Site ModelControl mutation", async () => {
    const resolver = new AdminControlPlaneResolver({
      peer: () => peer,
      authenticator: { authenticate: vi.fn(async () => authenticated) } as never,
      clock: () => new Date(now),
    });
    await expect(resolver.resolveModelControlCommand(
      commandContext("global"), transport,
      {
        operation: "model.site-policy.change",
        siteRef: "site:alpha",
        resourceRefs: ["site:alpha"],
        scope: "site",
        purpose: "model_control_administration",
        contextScopes: ["model:site-policy:manage"],
      },
    )).rejects.toThrow("MODEL_CONTROL_SCOPE_KIND_INVALID");
  });
});

const now = "2026-07-29T12:00:00.000Z";
const session: AuthenticatedAdminSession = Object.freeze({
  operatorRef: "operator:7",
  operatorGeneration: 2n,
  operatorSecurityEpoch: 3n,
  sessionRef: "session:9",
  sessionEpoch: 4n,
  restrictionEpoch: 5n,
  policyEpoch: 6n,
  workloadIdentityRef: "spiffe://kokoro/web-admin",
  audience: "platform-admin",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:3",
  assuranceLevel: "phishing_resistant",
  factorClasses: Object.freeze(["oidc", "webauthn"]),
  authenticatedAt: "2026-07-29T11:50:00.000Z",
  stepUpAt: "2026-07-29T11:59:00.000Z",
  expiresAt: "2026-07-29T13:00:00.000Z",
});
const authenticated = Object.freeze({
  session,
  authority: Object.freeze({
    operatorRef: session.operatorRef,
    operatorGeneration: session.operatorGeneration,
    operatorSecurityEpoch: session.operatorSecurityEpoch,
    state: "active" as const,
    permissions: Object.freeze([
      "model.inventory.import",
      "model.inventory.activate",
      "model.site-policy.change",
      "model.option.materialize",
      "model.site-release-catalog.publish",
    ]),
    expiresAt: "2026-07-29T13:00:00.000Z",
    siteScopes: Object.freeze([{
      siteRef: "site:alpha",
      environment: "production",
      region: "us-east-1",
      scopeEpoch: 7n,
      expiresAt: "2026-07-29T13:00:00.000Z",
    }]),
    globalScopes: Object.freeze([{
      grantRef: "grant:global",
      environment: "production",
      region: "us-east-1",
      scopeEpoch: 8n,
      expiresAt: "2026-07-29T13:00:00.000Z",
    }]),
    breakGlassScopes: Object.freeze([]),
  }),
});
const peer = Object.freeze({
  workloadIdentityRef: session.workloadIdentityRef,
  environment: session.environment,
  region: session.region,
  audience: session.audience,
  managedDeviceRef: session.managedDeviceRef,
  bindingEpoch: 9n,
});
const transport = {
  requestHeader: new Headers({ authorization: `Bearer ${"x".repeat(32)}` }),
} as HandlerContext;

function commandContext(scope: "global" | "site") {
  const attestation = operatorAttestation(session);
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "idempotency-key-0001",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "a".repeat(64),
    }),
    actorRef: session.operatorRef,
    operatorGeneration: session.operatorGeneration,
    operatorSessionRef: session.sessionRef,
    environment: session.environment,
    region: session.region,
    managedDeviceRef: session.managedDeviceRef,
    assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
    factorClasses: [...session.factorClasses],
    authenticatedAt: timestampFromDate(new Date(session.authenticatedAt)),
    stepUpAt: timestampFromDate(new Date(session.stepUpAt!)),
    operatorAttestationRef: attestation.ref,
    operatorAttestationDigest: attestation.digest,
    securityEpochs: create(SecurityEpochsSchema, {
      operatorSecurityEpoch: session.operatorSecurityEpoch,
      sessionEpoch: session.sessionEpoch,
      restrictionEpoch: session.restrictionEpoch,
      policyEpoch: session.policyEpoch,
      ...(scope === "site" ? { siteSecurityEpoch: 7n } : {}),
    }),
    scope: create(OperatorScopeSchema, {
      kind: scope === "site"
        ? { case: "site", value: create(SiteScopeSchema, {
            siteIds: ["site:alpha"],
            environment: session.environment,
            region: session.region,
          }) }
        : { case: "global", value: create(GlobalScopeSchema, {
            grantId: "grant:global",
            environment: session.environment,
            region: session.region,
          }) },
    }),
  });
}
