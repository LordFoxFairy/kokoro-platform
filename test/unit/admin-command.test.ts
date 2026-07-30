import { describe, expect, it } from "vitest";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import {
  AdminCommandRegistry,
  admitAdminCommand,
  defineAdminCommand,
} from "../../src/modules/admin-control/domain/admin-command.js";

const suspend = defineAdminCommand({
  commandId: "site.suspend", permission: "site.lifecycle.suspend", effectClass: "dangerous",
  scopeKind: "site", approvalPolicy: "pre_effect", reasonRequired: true,
});
const context = Object.freeze({
  environment: "production", region: "us-east-1",
  trustedCaller: { kind: "admin_workload", environment: "production", region: "us-east-1",
    allowedOperations: ["site.suspend"] },
  actor: { kind: "operator", subjectId: "operator_01", subjectGeneration: "3",
    assuranceLevel: "phishing_resistant", stepUpAt: "2026-07-28T12:58:00.000Z" },
  target: { siteId: "site_01", purpose: "site.suspend", scopes: ["site:lifecycle"] },
}) as unknown as VerifiedRequestSecurityContext;
const authority = Object.freeze({
  operatorRef: "operator_01", operatorGeneration: 3n, state: "active" as const,
  permissions: ["site.lifecycle.*"], siteScopes: ["site_01"], globalScopes: ["grant_global_01"], environments: ["production"],
  regions: ["us-east-1"], authorizationEpoch: 9n, expiresAt: "2026-07-28T14:00:00.000Z",
  breakGlassExpiresAt: null,
});

describe("Admin command policy", () => {
  it("registers a closed, typed command inventory", () => {
    const registry = new AdminCommandRegistry([suspend]);
    expect(registry.require("site.suspend")).toEqual(suspend);
    expect(() => registry.require("raw.sql.execute")).toThrow("ADMIN_COMMAND_NOT_REGISTERED");
    expect(() => new AdminCommandRegistry([suspend, suspend])).toThrow("ADMIN_COMMAND_DUPLICATE");
  });

  it("freezes Site, operator generation, current authority epoch, reason and approval policy", () => {
    expect(admitAdminCommand({ definition: suspend, context, authority, targetSiteRef: "site_01",
      reason: "security incident 1842", breakGlassTicketRef: null,
      now: "2026-07-28T13:00:00.000Z" })).toEqual({
      commandId: "site.suspend", operatorRef: "operator_01", operatorGeneration: 3n,
      authorizationEpoch: 9n, siteRef: "site_01", environment: "production", region: "us-east-1",
      effectClass: "dangerous", approvalPolicy: "pre_effect", reason: "security incident 1842",
      breakGlassTicketRef: null, admittedAt: "2026-07-28T13:00:00.000Z",
    });
  });

  it("denies stale generation, Site scope, permission, step-up and weak assurance", () => {
    const execute = (patch: Record<string, unknown> = {}, authorityPatch: Record<string, unknown> = {}) =>
      admitAdminCommand({ definition: suspend, context: { ...context, ...patch } as VerifiedRequestSecurityContext,
        authority: { ...authority, ...authorityPatch }, targetSiteRef: "site_01", reason: "incident",
        breakGlassTicketRef: null, now: "2026-07-28T13:00:00.000Z" });
    expect(() => execute({}, { operatorGeneration: 4n })).toThrow("ADMIN_OPERATOR_AUTHORITY_INVALID");
    expect(() => execute({}, { siteScopes: ["site_02"] })).toThrow("ADMIN_SITE_SCOPE_DENIED");
    expect(() => execute({}, { permissions: ["credit.read"] })).toThrow("ADMIN_PERMISSION_DENIED");
    expect(() => execute({ actor: { ...context.actor, stepUpAt: "2026-07-28T12:50:00.000Z" } }))
      .toThrow("ADMIN_STEP_UP_REQUIRED");
    expect(() => execute({ actor: { ...context.actor, assuranceLevel: "mfa" } }))
      .toThrow("ADMIN_PHISHING_RESISTANT_REQUIRED");
  });

  it("allows break-glass only with a live grant, explicit scope, ticket and post-effect review", () => {
    const definition = defineAdminCommand({ commandId: "site.emergency-revoke",
      permission: "site.lifecycle.emergency-revoke", effectClass: "break_glass", scopeKind: "site",
      approvalPolicy: "post_effect_review", reasonRequired: true });
    const breakGlassContext = { ...context,
      trustedCaller: { ...context.trustedCaller, allowedOperations: [definition.commandId] },
      target: { ...context.target, purpose: definition.commandId, scopes: ["admin:break-glass"] },
    } as VerifiedRequestSecurityContext;
    expect(admitAdminCommand({ definition, context: breakGlassContext,
      authority: { ...authority, permissions: ["site.lifecycle.*"],
        breakGlassExpiresAt: "2026-07-28T13:05:00.000Z" }, targetSiteRef: "site_01",
      reason: "active credential exfiltration", breakGlassTicketRef: "incident_1842",
      now: "2026-07-28T13:00:00.000Z" })).toMatchObject({ approvalPolicy: "post_effect_review",
        breakGlassTicketRef: "incident_1842" });
  });
});
