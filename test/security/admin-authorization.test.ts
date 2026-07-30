import { describe, expect, it } from "vitest";
import {
  authorizeAdminOperation,
  type AdminOperatorAuthority,
  type AuthenticatedAdminSession,
} from "../../src/modules/admin/domain/admin-authorization.js";

const now = new Date("2026-07-29T15:00:00.000Z");
const session: AuthenticatedAdminSession = Object.freeze({
  operatorRef: "operator:maker",
  operatorGeneration: 4n,
  operatorSecurityEpoch: 7n,
  sessionRef: "operator-session:1",
  sessionEpoch: 3n,
  restrictionEpoch: 5n,
  policyEpoch: 11n,
  workloadIdentityRef: "spiffe://kokoro/web/admin",
  audience: "platform-admin",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:managed:1",
  assuranceLevel: "phishing_resistant",
  factorClasses: ["oidc", "webauthn"],
  authenticatedAt: "2026-07-29T14:30:00.000Z",
  stepUpAt: "2026-07-29T14:58:00.000Z",
  expiresAt: "2026-07-29T15:10:00.000Z",
});
const authority: AdminOperatorAuthority = Object.freeze({
  operatorRef: session.operatorRef,
  operatorGeneration: session.operatorGeneration,
  operatorSecurityEpoch: session.operatorSecurityEpoch,
  state: "active",
  permissions: ["site.read", "admin.authority.manage", "support.case.read"],
  expiresAt: "2026-07-30T15:00:00.000Z",
  siteScopes: [{
    siteRef: "site:alpha",
    environment: "production",
    region: "us-east-1",
    scopeEpoch: 2n,
    expiresAt: "2026-07-30T15:00:00.000Z",
  }],
  globalScopes: [{
    grantRef: "global-grant:1",
    environment: "production",
    region: "us-east-1",
    scopeEpoch: 9n,
    expiresAt: "2026-07-29T16:00:00.000Z",
  }],
  breakGlassScopes: [{
    grantRef: "breakglass-grant:1",
    incidentRef: "incident:42",
    environment: "production",
    region: "us-east-1",
    authorizedOperation: "support.case.read",
    resourceRefs: ["case:7"],
    fieldAllowlist: ["timeline", "status"],
    scopeEpoch: 12n,
    expiresAt: "2026-07-29T15:20:00.000Z",
  }],
});

describe("typed Admin authorization", () => {
  it("authorizes an exact Site scope without a wildcard fallback", () => {
    expect(authorizeAdminOperation({
      session,
      authority,
      operation: "site.read",
      requiredPermission: "site.read",
      scope: {
        kind: "site",
        siteRefs: ["site:alpha"],
        environment: "production",
        region: "us-east-1",
      },
      target: { siteRef: "site:alpha", resourceRefs: ["site:alpha"], fieldRefs: [] },
      now,
      mutation: false,
    })).toMatchObject({ kind: "site", siteRef: "site:alpha", scopeEpoch: 2n });

    expect(() => authorizeAdminOperation({
      session,
      authority: { ...authority, siteScopes: [] },
      operation: "site.read",
      requiredPermission: "site.read",
      scope: {
        kind: "site",
        siteRefs: ["*"],
        environment: "production",
        region: "us-east-1",
      },
      target: { siteRef: "site:alpha", resourceRefs: ["site:alpha"], fieldRefs: [] },
      now,
      mutation: false,
    })).toThrow("ADMIN_SITE_SCOPE_INVALID");
  });

  it("requires an explicit active Global grant and exact deployment axes", () => {
    expect(authorizeAdminOperation({
      session,
      authority,
      operation: "admin.authority.manage",
      requiredPermission: "admin.authority.manage",
      scope: {
        kind: "global",
        grantRef: "global-grant:1",
        environment: "production",
        region: "us-east-1",
      },
      target: { siteRef: null, resourceRefs: ["operator:target"], fieldRefs: [] },
      now,
      mutation: true,
    })).toMatchObject({ kind: "global", grantRef: "global-grant:1", scopeEpoch: 9n });

    expect(() => authorizeAdminOperation({
      session,
      authority,
      operation: "admin.authority.manage",
      requiredPermission: "admin.authority.manage",
      scope: {
        kind: "global",
        grantRef: "global-grant:1",
        environment: "staging",
        region: "us-east-1",
      },
      target: { siteRef: null, resourceRefs: ["operator:target"], fieldRefs: [] },
      now,
      mutation: true,
    })).toThrow("ADMIN_SCOPE_DEPLOYMENT_MISMATCH");
  });

  it("never treats BreakGlass as Global and fences exact operation, resource, field and TTL", () => {
    expect(authorizeAdminOperation({
      session,
      authority,
      operation: "support.case.read",
      requiredPermission: "support.case.read",
      scope: {
        kind: "breakglass",
        grantRef: "breakglass-grant:1",
        incidentRef: "incident:42",
        environment: "production",
        region: "us-east-1",
        authorizedOperation: "support.case.read",
        resourceRefs: ["case:7"],
        fieldAllowlist: ["timeline", "status"],
        expiresAt: "2026-07-29T15:20:00.000Z",
      },
      target: { siteRef: null, resourceRefs: ["case:7"], fieldRefs: ["status"] },
      now,
      mutation: false,
    })).toMatchObject({ kind: "breakglass", grantRef: "breakglass-grant:1" });

    for (const target of [
      { siteRef: null, resourceRefs: ["case:8"], fieldRefs: ["status"] },
      { siteRef: null, resourceRefs: ["case:7"], fieldRefs: ["email"] },
    ]) {
      expect(() => authorizeAdminOperation({
        session,
        authority,
        operation: "support.case.read",
        requiredPermission: "support.case.read",
        scope: {
          kind: "breakglass",
          grantRef: "breakglass-grant:1",
          incidentRef: "incident:42",
          environment: "production",
          region: "us-east-1",
          authorizedOperation: "support.case.read",
          resourceRefs: ["case:7"],
          fieldAllowlist: ["timeline", "status"],
          expiresAt: "2026-07-29T15:20:00.000Z",
        },
        target,
        now,
        mutation: false,
      })).toThrow("ADMIN_BREAKGLASS_TARGET_DENIED");
    }
  });

  it("rejects stale epochs, unmanaged devices and self-escalation", () => {
    expect(() => authorizeAdminOperation({
      session: { ...session, operatorSecurityEpoch: 6n },
      authority,
      operation: "admin.authority.manage",
      requiredPermission: "admin.authority.manage",
      scope: {
        kind: "global",
        grantRef: "global-grant:1",
        environment: "production",
        region: "us-east-1",
      },
      target: { siteRef: null, resourceRefs: [session.operatorRef], fieldRefs: ["permissions"] },
      now,
      mutation: true,
      authorityTargetOperatorRef: session.operatorRef,
    })).toThrow("ADMIN_SESSION_SECURITY_EPOCH_STALE");

    expect(() => authorizeAdminOperation({
      session,
      authority,
      operation: "admin.authority.manage",
      requiredPermission: "admin.authority.manage",
      scope: {
        kind: "global",
        grantRef: "global-grant:1",
        environment: "production",
        region: "us-east-1",
      },
      target: { siteRef: null, resourceRefs: [session.operatorRef], fieldRefs: ["permissions"] },
      now,
      mutation: true,
      authorityTargetOperatorRef: session.operatorRef,
    })).toThrow("ADMIN_SELF_ESCALATION_DENIED");
  });

  it("fails closed on malformed session, authority and step-up timestamps", () => {
    const request = (sessionOverride: AuthenticatedAdminSession, authorityOverride = authority) =>
      authorizeAdminOperation({
        session: sessionOverride,
        authority: authorityOverride,
        operation: "admin.authority.manage",
        requiredPermission: "admin.authority.manage",
        scope: {
          kind: "global", grantRef: "global-grant:1",
          environment: "production", region: "us-east-1",
        },
        target: { siteRef: null, resourceRefs: ["operator:target"], fieldRefs: [] },
        now,
        mutation: true,
      });

    expect(() => request({ ...session, expiresAt: "not-an-instant" }))
      .toThrow("ADMIN_SESSION_INVALID");
    expect(() => request({ ...session, stepUpAt: "not-an-instant" }))
      .toThrow("ADMIN_STEP_UP_REQUIRED");
    expect(() => request(session, { ...authority, expiresAt: "not-an-instant" }))
      .toThrow("ADMIN_OPERATOR_AUTHORITY_INVALID");
  });
});
