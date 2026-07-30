import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  AdminQueryService as AdminQueryServiceDescriptor,
  AuditRecordSchema,
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
  readonly operation: "admin.site.read" | "admin.site.list" | "admin.user.read" | "admin.audit.read";
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
  };
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

function permitBinding(permit: AdminQueryPermit): string {
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

function pageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("ADMIN_PAGE_SIZE_INVALID");
  }
  return value;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("ADMIN_QUERY_CONTEXT_REQUIRED");
  return value;
}
