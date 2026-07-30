import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  AdminQueryService as AdminQueryServiceDescriptor,
  AuditRecordSchema,
  EffectiveSiteScopeSchema,
  OperatorState,
  OperatorSummarySchema,
  PendingApprovalSummarySchema,
  SiteSummarySchema,
  UserSummarySchema,
} from "../../../../interfaces/connect/generated-admin-query-v2/kokoro/platform/admin/v2/admin_query_pb.js";
import type { AuthenticatedOperatorQueryContext } from
  "../../../../interfaces/connect/generated-admin-query-v2/kokoro/platform/admin/v2/admin_shared_pb.js";

export type AdminQueryConnectService = ServiceImpl<typeof AdminQueryServiceDescriptor>;

export type AdminQueryScope =
  | Readonly<{ kind: "site"; siteRefs: readonly string[] }>
  | Readonly<{ kind: "global"; grantRef: string }>
  | Readonly<{
      kind: "breakglass";
      grantRef: string;
      resourceRefs: readonly string[];
      fieldAllowlist: readonly string[];
    }>;

export interface AdminQueryPermit {
  readonly operatorRef: string;
  readonly environment: string;
  readonly region: string;
  readonly operation: "admin.site.read" | "admin.site.list" | "admin.user.read" | "admin.audit.read" |
    "admin.operator.self.read" | "admin.operator.read" | "admin.operator.list" | "admin.approval.list" |
    "commerce.credit-program.read" | "commerce.entitlement-template.read" |
    "commerce.offer.read" | "commerce.redemption-program.read" | "commerce.code-batch.read" |
    "credit.summary.read" | "credit.account.read" | "credit.grant.read" | "credit.hold.read" |
    "credit.journal.read" | "credit.rated-usage.read";
  readonly scope: AdminQueryScope;
}

export interface AdminQueryResolver {
  resolve(
    claimed: AuthenticatedOperatorQueryContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: AdminQueryPermit["operation"];
      siteRef: string | null;
      resourceRefs: readonly string[];
      fieldRefs: readonly string[];
    }>,
  ): Promise<AdminQueryPermit>;
}

export interface AdminQueryReader {
  getSite(permit: AdminQueryPermit, siteRef: string): Promise<Readonly<{
    siteRef: string;
    status: string;
    securityEpoch: bigint;
  }> | null>;
  listSites(permit: AdminQueryPermit, page: Readonly<{
    afterSiteRef: string | null;
    limit: number;
  }>): Promise<readonly Readonly<{ siteRef: string; status: string; securityEpoch: bigint }>[] >;
  getUser(permit: AdminQueryPermit, siteRef: string, userRef: string): Promise<Readonly<{
    userRef: string;
    status: string;
    securityEpoch: bigint;
  }> | null>;
  listAudit(permit: AdminQueryPermit, page: Readonly<{
    before: Readonly<{ occurredAt: string; auditRef: string }> | null;
    limit: number;
  }>): Promise<readonly Readonly<{
    auditRef: string;
    actionCode: string;
    occurredAt: string;
  }>[] >;
  getOperator(permit: AdminQueryPermit, operatorRef: string): Promise<AdminOperatorRecord | null>;
  listOperators(permit: AdminQueryPermit, page: Readonly<{
    afterOperatorRef: string | null; limit: number;
  }>): Promise<readonly AdminOperatorRecord[]>;
  listPendingApprovals(permit: AdminQueryPermit, input: Readonly<{
    siteRef: string | null; before: Readonly<{ admittedAt: string; approvalRef: string }> | null;
    limit: number;
  }>): Promise<readonly AdminPendingApprovalRecord[]>;
}

export interface AdminOperatorRecord {
  readonly operatorRef: string;
  readonly operatorGeneration: bigint;
  readonly state: "active" | "suspended" | "revoked";
  readonly effectivePermissions: readonly string[];
  readonly effectiveSiteScopes: readonly Readonly<{
    siteId: string; environment: string; region: string; scopeEpoch: bigint; expiresAt: string;
  }>[];
  readonly operatorSecurityEpoch: bigint;
  readonly authorizationEpoch: bigint;
  readonly expiresAt: string;
}

export interface AdminPendingApprovalRecord {
  readonly approvalRef: string;
  readonly operation: string;
  readonly makerRef: string;
  readonly targetSiteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly operatorReason: string;
  readonly admittedAt: string;
  readonly expiresAt: string;
}

export interface AdminPageCursorCodec {
  encode(value: Readonly<Record<string, string>>): string;
  decode(value: string): Readonly<Record<string, string>>;
}

export function createAdminQueryConnectService(input: Readonly<{
  resolver: AdminQueryResolver;
  reader: AdminQueryReader;
  cursors: AdminPageCursorCodec;
}>): AdminQueryConnectService {
  return {
    async getSite(request, transport) {
      const context = required(request.context);
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.site.read",
        siteRef: request.siteId,
        resourceRefs: [request.siteId],
        fieldRefs: ["site_ref", "status", "security_epoch"],
      });
      const site = await input.reader.getSite(permit, request.siteId);
      if (site === null) throw new Error("ADMIN_SITE_NOT_FOUND");
      return { site: create(SiteSummarySchema, site) };
    },

    async listSites(request, transport) {
      const context = required(request.context);
      const limit = pageSize(request.pageSize);
      const cursor = request.pageToken === undefined ? null : input.cursors.decode(request.pageToken);
      if (cursor !== null) requireCursor(cursor, ["after", "binding", "kind"], "sites");
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.site.list",
        siteRef: null,
        resourceRefs: [],
        fieldRefs: ["site_ref", "status", "security_epoch"],
      });
      const binding = permitBinding(permit);
      if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
      const rows = await input.reader.listSites(permit, {
        afterSiteRef: cursor?.after ?? null,
        limit: limit + 1,
      });
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        sites: visible.map((site) => create(SiteSummarySchema, site)),
        ...(rows.length > limit && last !== undefined
          ? { nextPageToken: input.cursors.encode({
              kind: "sites", after: last.siteRef, binding,
            }) }
          : {}),
      };
    },

    async getUserWithinSite(request, transport) {
      const context = required(request.context);
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.user.read",
        siteRef: request.siteId,
        resourceRefs: [request.siteId, request.userRef],
        fieldRefs: ["user_ref", "status", "security_epoch"],
      });
      const user = await input.reader.getUser(permit, request.siteId, request.userRef);
      if (user === null) throw new Error("ADMIN_USER_NOT_FOUND");
      return { user: create(UserSummarySchema, user) };
    },

    async getAuditWithinScope(request, transport) {
      const context = required(request.context);
      const limit = pageSize(request.pageSize);
      const cursor = request.pageToken === undefined ? null : input.cursors.decode(request.pageToken);
      if (cursor !== null) requireCursor(cursor, ["at", "binding", "kind", "ref"], "audit");
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.audit.read",
        siteRef: null,
        resourceRefs: [],
        fieldRefs: ["audit_ref", "action_code", "occurred_at"],
      });
      const binding = permitBinding(permit);
      if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
      const rows = await input.reader.listAudit(permit, {
        before: cursor === null ? null : { occurredAt: cursor.at!, auditRef: cursor.ref! },
        limit: limit + 1,
      });
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return {
        records: visible.map((record) => create(AuditRecordSchema, {
          auditRef: record.auditRef,
          actionCode: record.actionCode,
          occurredAt: timestampFromDate(new Date(record.occurredAt)),
        })),
        ...(rows.length > limit && last !== undefined
          ? { nextPageToken: input.cursors.encode({
              kind: "audit", at: last.occurredAt, ref: last.auditRef, binding,
            }) }
          : {}),
      };
    },

    async getCurrentOperator(request, transport) {
      const context = required(request.context);
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.operator.self.read", siteRef: null,
        resourceRefs: [context.actorRef], fieldRefs: operatorFields,
      });
      const operator = await input.reader.getOperator(permit, permit.operatorRef);
      if (operator === null) throw new Error("ADMIN_OPERATOR_NOT_FOUND");
      return { operator: operatorMessage(operator) };
    },

    async getOperator(request, transport) {
      const context = required(request.context);
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.operator.read", siteRef: null,
        resourceRefs: [request.operatorRef], fieldRefs: operatorFields,
      });
      const operator = await input.reader.getOperator(permit, request.operatorRef);
      if (operator === null) throw new Error("ADMIN_OPERATOR_NOT_FOUND");
      return { operator: operatorMessage(operator) };
    },

    async listOperators(request, transport) {
      const context = required(request.context); const limit = pageSize(request.pageSize);
      const cursor = request.pageToken === undefined ? null : input.cursors.decode(request.pageToken);
      if (cursor !== null) requireCursor(cursor, ["after", "binding", "kind"], "operators");
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.operator.list", siteRef: null, resourceRefs: [], fieldRefs: operatorFields,
      });
      const binding = permitBinding(permit);
      if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
      const rows = await input.reader.listOperators(permit, {
        afterOperatorRef: cursor?.after ?? null, limit: limit + 1,
      });
      const visible = rows.slice(0, limit); const last = visible.at(-1);
      return { operators: visible.map(operatorMessage), ...(rows.length > limit && last !== undefined
        ? { nextPageToken: input.cursors.encode({ kind: "operators", after: last.operatorRef, binding }) }
        : {}) };
    },

    async listPendingApprovals(request, transport) {
      const context = required(request.context); const limit = pageSize(request.pageSize);
      const cursor = request.pageToken === undefined ? null : input.cursors.decode(request.pageToken);
      if (cursor !== null) requireCursor(cursor, ["at", "binding", "kind", "ref"], "approvals");
      const permit = await input.resolver.resolve(context, transport, {
        operation: "admin.approval.list", siteRef: request.siteId ?? null,
        resourceRefs: request.siteId === undefined ? [] : [request.siteId],
        fieldRefs: ["approval_ref", "operation", "maker_ref", "target_site_ref", "operator_reason", "admitted_at", "expires_at"],
      });
      const binding = scopedBinding(permit, request.siteId ?? "*");
      if (cursor !== null && cursor.binding !== binding) throw new Error("ADMIN_PAGE_TOKEN_INVALID");
      const rows = await input.reader.listPendingApprovals(permit, {
        siteRef: request.siteId ?? null,
        before: cursor === null ? null : { admittedAt: cursor.at!, approvalRef: cursor.ref! },
        limit: limit + 1,
      });
      const visible = rows.slice(0, limit); const last = visible.at(-1);
      return { approvals: visible.map((approval) => create(PendingApprovalSummarySchema, {
        approvalRef: approval.approvalRef, operation: approval.operation, makerRef: approval.makerRef,
        environment: approval.environment, region: approval.region, operatorReason: approval.operatorReason,
        ...(approval.targetSiteRef === null ? {} : { targetSiteRef: approval.targetSiteRef }),
        admittedAt: timestampFromDate(new Date(approval.admittedAt)),
        expiresAt: timestampFromDate(new Date(approval.expiresAt)),
      })), ...(rows.length > limit && last !== undefined ? { nextPageToken: input.cursors.encode({
        kind: "approvals", at: last.admittedAt, ref: last.approvalRef, binding,
      }) } : {}) };
    },
  };
}

const operatorFields = ["operator_ref", "operator_generation", "state", "permissions", "site_scopes",
  "operator_security_epoch", "authorization_epoch", "expires_at"] as const;

function operatorMessage(operator: AdminOperatorRecord) {
  const states = { active: OperatorState.ACTIVE, suspended: OperatorState.SUSPENDED,
    revoked: OperatorState.REVOKED } as const;
  return create(OperatorSummarySchema, { ...operator, state: states[operator.state],
    effectivePermissions: [...operator.effectivePermissions],
    effectiveSiteScopes: operator.effectiveSiteScopes.map((scope) => create(EffectiveSiteScopeSchema, {
      ...scope, expiresAt: timestampFromDate(new Date(scope.expiresAt)),
    })), expiresAt: timestampFromDate(new Date(operator.expiresAt)) });
}

function requireCursor(
  cursor: Readonly<Record<string, string>>,
  fields: readonly string[],
  kind: string,
): void {
  if (cursor.kind !== kind || Object.keys(cursor).sort().join(",") !== fields.join(",")) {
    throw new Error("ADMIN_PAGE_TOKEN_INVALID");
  }
}

export function permitBinding(permit: AdminQueryPermit): string {
  const scope = permit.scope.kind === "site"
    ? { kind: permit.scope.kind, siteRefs: [...permit.scope.siteRefs].sort() }
    : permit.scope.kind === "global"
      ? { kind: permit.scope.kind, grantRef: permit.scope.grantRef }
      : {
          kind: permit.scope.kind,
          grantRef: permit.scope.grantRef,
          resourceRefs: [...permit.scope.resourceRefs].sort(),
          fieldAllowlist: [...permit.scope.fieldAllowlist].sort(),
        };
  return createHash("sha256").update("kokoro.admin-page-permit.v1").update("\0")
    .update(JSON.stringify({
      operatorRef: permit.operatorRef,
      environment: permit.environment,
      region: permit.region,
      operation: permit.operation,
      scope,
    })).digest("hex");
}

export function scopedBinding(permit: AdminQueryPermit, scopeRef: string): string {
  return createHash("sha256").update(permitBinding(permit)).update("\0").update(scopeRef).digest("hex");
}

function pageSize(value: number): number {
  if (value === 0) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("ADMIN_PAGE_SIZE_INVALID");
  }
  return value;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("ADMIN_QUERY_CONTEXT_REQUIRED");
  return value;
}
