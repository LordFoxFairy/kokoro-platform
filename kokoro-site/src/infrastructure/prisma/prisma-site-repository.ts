import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../../generated/prisma/index.js";
import type {
  ResolveSiteContextInput,
  SiteRepository,
  UpsertSiteAppInput,
  UpsertSiteDomainInput,
  UpsertSiteFeatureFlagInput,
  UpsertSiteInput,
  UpsertSitePolicyInput,
} from "../../domain/repository.js";
import { coerceJsonValue, type JsonObject } from "../../domain/json.js";
import type { ResolvedSiteContext } from "../../domain/site-context.js";
import { SiteLifecycleError } from "../../domain/site-deletion.js";
import type { AdminListOptions, DeleteInput, ListOptions, RestoreInput } from "../../domain/site-deletion.js";
import type { Site } from "../../domain/site.js";
import type { SiteApp } from "../../domain/site-app.js";
import type { SiteDomain } from "../../domain/site-domain.js";
import type { SiteFeatureFlag } from "../../domain/site-feature-flag.js";
import type { SitePolicy } from "../../domain/site-policy.js";

export class PrismaSiteRepository implements SiteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertSite(input: UpsertSiteInput): Promise<Site> {
    const key = normalizeKey(input.key);
    const existing = await this.prisma.site.findUnique({ where: { key } });
    if (existing?.deletedAt) {
      throw new SiteLifecycleError("site.deleted", "站点已删除，请先恢复后再修改", 409);
    }

    if (!existing) {
      const created = await this.prisma.site.create({
        data: {
          // siteId 契约：全平台租户主键 = `site-<key>`，人读且确定性，跨服务一致（不用 cuid）。
          id: `site-${key}`,
          key,
          name: input.name,
          status: input.status ?? "draft",
          defaultLocale: input.defaultLocale ?? "zh-CN",
          timezone: input.timezone ?? "Asia/Shanghai",
          brandLogoUrl: input.brandLogoUrl ?? null,
          brandThemeColor: input.brandThemeColor ?? null,
          ...definedJson("metadata", input.metadata),
        },
      });
      return mapSite(created);
    }

    const site = await this.prisma.site.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        ...definedValue("status", input.status),
        ...definedValue("defaultLocale", input.defaultLocale),
        ...definedValue("timezone", input.timezone),
        ...definedValue("brandLogoUrl", input.brandLogoUrl),
        ...definedValue("brandThemeColor", input.brandThemeColor),
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSite(site);
  }

  async deleteSite(input: DeleteInput): Promise<Site> {
    const existing = await this.prisma.site.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw new SiteLifecycleError("site.not_found", "站点不存在", 404);
    }
    if (existing.deletedAt) {
      return mapSite(existing);
    }

    const site = await this.prisma.site.update({
      where: { id: input.id },
      data: deletionData(input),
    });

    return mapSite(site);
  }

  async restoreSite(input: RestoreInput): Promise<Site> {
    const existing = await this.prisma.site.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw new SiteLifecycleError("site.not_found", "站点不存在", 404);
    }
    if (!existing.deletedAt) {
      return mapSite(existing);
    }

    const site = await this.prisma.site.update({
      where: { id: input.id },
      data: restoreData(),
    });

    return mapSite(site);
  }

  async upsertSiteDomain(input: UpsertSiteDomainInput): Promise<SiteDomain> {
    await this.assertWritableSite(input.siteId);

    const host = normalizeHost(input.host);
    const existing = await this.prisma.siteDomain.findUnique({ where: { host } });
    if (existing?.deletedAt) {
      throw new SiteLifecycleError("site_domain.deleted", "站点域名已删除，请先恢复后再修改", 409);
    }

    if (!existing) {
      const created = await this.prisma.siteDomain.create({
        data: {
          siteId: input.siteId,
          host,
          status: input.status ?? "active",
          isPrimary: input.isPrimary ?? false,
          canonicalHost: normalizeOptionalHost(input.canonicalHost),
          // 每个新域名生成一次性 TXT 验证令牌供运营公示；已 active 的域名也带令牌以便未来复验。
          verificationToken: generateVerificationToken(),
          ...definedJson("metadata", input.metadata),
        },
      });

      return mapSiteDomain(created);
    }

    const domain = await this.prisma.siteDomain.update({
      where: { id: existing.id },
      data: {
        siteId: input.siteId,
        ...definedValue("status", input.status),
        ...definedValue("isPrimary", input.isPrimary),
        ...definedNullableHost("canonicalHost", input.canonicalHost),
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSiteDomain(domain);
  }

  async deleteSiteDomain(input: DeleteInput): Promise<SiteDomain> {
    const existing = await this.prisma.siteDomain.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw new SiteLifecycleError("site_domain.not_found", "站点域名不存在", 404);
    }
    if (existing.deletedAt) {
      return mapSiteDomain(existing);
    }

    const domain = await this.prisma.siteDomain.update({
      where: { id: input.id },
      data: deletionData(input),
    });

    return mapSiteDomain(domain);
  }

  async restoreSiteDomain(input: RestoreInput): Promise<SiteDomain> {
    const existing = await this.prisma.siteDomain.findUnique({ where: { id: input.id } });
    if (!existing) {
      throw new SiteLifecycleError("site_domain.not_found", "站点域名不存在", 404);
    }
    if (!existing.deletedAt) {
      return mapSiteDomain(existing);
    }

    const domain = await this.prisma.siteDomain.update({
      where: { id: input.id },
      data: restoreData(),
    });

    return mapSiteDomain(domain);
  }

  async getSiteDomainById(id: string): Promise<SiteDomain | null> {
    const domain = await this.prisma.siteDomain.findUnique({ where: { id } });
    if (!domain || domain.deletedAt) {
      return null;
    }
    return mapSiteDomain(domain);
  }

  async markSiteDomainVerified(id: string): Promise<SiteDomain> {
    const existing = await this.prisma.siteDomain.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new SiteLifecycleError("site_domain.not_found", "站点域名不存在", 404);
    }

    const domain = await this.prisma.siteDomain.update({
      where: { id },
      data: { status: "active", verifiedAt: new Date() },
    });

    return mapSiteDomain(domain);
  }

  async upsertSiteApp(input: UpsertSiteAppInput): Promise<SiteApp> {
    await this.assertWritableSite(input.siteId);

    const existing = await this.prisma.siteApp.findUnique({
      where: {
        siteId_appKey_surface: {
          siteId: input.siteId,
          appKey: input.appKey,
          surface: input.surface,
        },
      },
    });
    if (existing?.deletedAt) {
      throw new SiteLifecycleError("site_app.deleted", "站点应用已删除，请先恢复后再修改", 409);
    }

    const app = await this.prisma.siteApp.upsert({
      where: {
        siteId_appKey_surface: {
          siteId: input.siteId,
          appKey: input.appKey,
          surface: input.surface,
        },
      },
      create: {
        siteId: input.siteId,
        appKey: input.appKey,
        surface: input.surface,
        status: input.status ?? "active",
        defaultRoute: input.defaultRoute ?? null,
        ...definedJson("metadata", input.metadata),
      },
      update: {
        ...definedValue("status", input.status),
        ...definedValue("defaultRoute", input.defaultRoute),
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSiteApp(app);
  }

  async upsertSitePolicy(input: UpsertSitePolicyInput): Promise<SitePolicy> {
    await this.assertWritableSite(input.siteId);

    const existing = await this.prisma.sitePolicy.findUnique({
      where: {
        siteId_key: {
          siteId: input.siteId,
          key: input.key,
        },
      },
    });
    if (existing?.deletedAt) {
      throw new SiteLifecycleError("site_policy.deleted", "站点策略已删除，请先恢复后再修改", 409);
    }

    const policy = await this.prisma.sitePolicy.upsert({
      where: {
        siteId_key: {
          siteId: input.siteId,
          key: input.key,
        },
      },
      create: {
        siteId: input.siteId,
        key: input.key,
        value: input.value,
        status: input.status ?? "active",
      },
      update: {
        value: input.value,
        ...definedValue("status", input.status),
      },
    });

    return mapSitePolicy(policy);
  }

  async upsertSiteFeatureFlag(input: UpsertSiteFeatureFlagInput): Promise<SiteFeatureFlag> {
    await this.assertWritableSite(input.siteId);

    const existing = await this.prisma.siteFeatureFlag.findUnique({
      where: {
        siteId_key: {
          siteId: input.siteId,
          key: input.key,
        },
      },
    });
    if (existing?.deletedAt) {
      throw new SiteLifecycleError("site_feature_flag.deleted", "站点功能开关已删除，请先恢复后再修改", 409);
    }

    const flag = await this.prisma.siteFeatureFlag.upsert({
      where: {
        siteId_key: {
          siteId: input.siteId,
          key: input.key,
        },
      },
      create: {
        siteId: input.siteId,
        key: input.key,
        enabled: input.enabled,
        ...definedJson("metadata", input.metadata),
      },
      update: {
        enabled: input.enabled,
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSiteFeatureFlag(flag);
  }

  async listSiteFeatureFlags(siteId: string): Promise<SiteFeatureFlag[]> {
    const flags = await this.prisma.siteFeatureFlag.findMany({
      where: { siteId, deletedAt: null, site: { deletedAt: null } },
      orderBy: { key: "asc" },
    });

    return flags.map(mapSiteFeatureFlag);
  }

  async resolveSiteContext(input: ResolveSiteContextInput): Promise<ResolvedSiteContext | null> {
    const domain = await this.prisma.siteDomain.findUnique({
      where: {
        host: normalizeHost(input.host),
      },
      include: {
        site: {
          include: {
            apps: {
              where: {
                ...(input.appKey ? { appKey: input.appKey } : {}),
                ...(input.surface ? { surface: input.surface } : {}),
                status: "active",
                deletedAt: null,
              },
              orderBy: {
                createdAt: "asc",
              },
              take: 1,
            },
          },
        },
      },
    });

    if (
      !domain ||
      domain.deletedAt ||
      domain.status !== "active" ||
      domain.site.deletedAt ||
      domain.site.status !== "active"
    ) {
      return null;
    }

    const app = domain.site.apps[0];
    const site = mapSite(domain.site);

    return {
      site,
      app: app ? mapSiteApp(app) : undefined,
      context: {
        siteId: site.id,
        siteKey: site.key,
        host: domain.host,
        appKey: app?.appKey ?? input.appKey,
        surface: app?.surface ?? input.surface,
        defaultLocale: site.defaultLocale,
        timezone: site.timezone,
        brand: {
          name: site.name,
          logoUrl: site.brandLogoUrl,
          themeColor: site.brandThemeColor,
        },
      },
    };
  }

  async resolveSiteActive(siteId: string): Promise<boolean> {
    const site = await this.prisma.site.findFirst({ where: { id: siteId, deletedAt: null } });
    return site !== null && site.status === "active";
  }

  async listSites(options?: ListOptions): Promise<Site[]> {
    const sites = await this.prisma.site.findMany({
      where: visibleRows(options),
      orderBy: {
        createdAt: "asc",
      },
    });

    return sites.map(mapSite);
  }

  async listAdminSites(options?: AdminListOptions): Promise<Site[]> {
    const sites = await this.prisma.site.findMany({
      where: { ...visibleRows(options), ...(options?.siteId ? { id: options.siteId } : {}) },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return sites.map(mapSite);
  }

  async listAdminSiteDomains(options?: AdminListOptions): Promise<SiteDomain[]> {
    const domains = await this.prisma.siteDomain.findMany({
      where: { ...visibleChildRows(options), ...(options?.siteId ? { siteId: options.siteId } : {}) },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return domains.map(mapSiteDomain);
  }

  async listAdminSiteApps(options?: AdminListOptions): Promise<SiteApp[]> {
    const apps = await this.prisma.siteApp.findMany({
      where: { ...visibleChildRows(options), ...(options?.siteId ? { siteId: options.siteId } : {}) },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return apps.map(mapSiteApp);
  }

  async listAdminSitePolicies(options?: AdminListOptions): Promise<SitePolicy[]> {
    const policies = await this.prisma.sitePolicy.findMany({
      where: { ...visibleChildRows(options), ...(options?.siteId ? { siteId: options.siteId } : {}) },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return policies.map(mapSitePolicy);
  }

  async listAdminSiteFeatureFlags(options?: AdminListOptions): Promise<SiteFeatureFlag[]> {
    const flags = await this.prisma.siteFeatureFlag.findMany({
      where: { ...visibleChildRows(options), ...(options?.siteId ? { siteId: options.siteId } : {}) },
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return flags.map(mapSiteFeatureFlag);
  }

  private async assertWritableSite(siteId: string): Promise<void> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new SiteLifecycleError("site.not_found", "站点不存在", 404);
    }
    if (site.deletedAt) {
      throw new SiteLifecycleError("site.deleted", "站点已删除，请先恢复后再修改", 409);
    }
  }
}

const ADMIN_LIST_LIMIT = 100;

// TXT 记录值：运营把它加到域名 DNS，verify 时比对。前缀让运营一眼识别归属。
function generateVerificationToken(): string {
  return `kokoro-site-verification=${randomUUID()}`;
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

// 站点 key 规范化（对齐 host），杜绝大小写/空格绕过 @unique 约束建出重复租户根。
function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function normalizeOptionalHost(host: string | undefined): string | null {
  return host ? normalizeHost(host) : null;
}

function definedValue<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, Value>> = {};
  out[key] = value;
  return out;
}

function definedJson<Key extends string>(
  key: Key,
  value: JsonObject | undefined,
): Partial<Record<Key, Prisma.InputJsonValue>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, Prisma.InputJsonValue>> = {};
  out[key] = value;
  return out;
}

function definedNullableHost<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string | null>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, string | null>> = {};
  out[key] = normalizeOptionalHost(value);
  return out;
}

function visibleRows(options: ListOptions | undefined): { deletedAt?: null } {
  return options?.includeDeleted ? {} : { deletedAt: null };
}

function visibleChildRows(options: ListOptions | undefined): {
  deletedAt?: null;
  site?: { deletedAt: null };
} {
  return options?.includeDeleted ? {} : { deletedAt: null, site: { deletedAt: null } };
}

function deletionData(input: DeleteInput): {
  deletedAt: Date;
  deletedBy: string | null;
  deleteReason: string | null;
} {
  return {
    deletedAt: new Date(),
    deletedBy: input.deletedBy ?? null,
    deleteReason: input.reason ?? null,
  };
}

function restoreData(): {
  deletedAt: null;
  deletedBy: null;
  deleteReason: null;
} {
  return {
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
  };
}

function mapDeletionAudit(record: {
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
}): {
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
} {
  return {
    deletedAt: record.deletedAt,
    deletedBy: record.deletedBy,
    deleteReason: record.deleteReason,
  };
}

function mapSite(site: {
  id: string;
  key: string;
  name: string;
  status: Site["status"];
  defaultLocale: string;
  timezone: string;
  brandLogoUrl: string | null;
  brandThemeColor: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Site {
  return {
    id: site.id,
    key: site.key,
    name: site.name,
    status: site.status,
    defaultLocale: site.defaultLocale,
    timezone: site.timezone,
    brandLogoUrl: site.brandLogoUrl,
    brandThemeColor: site.brandThemeColor,
    ...mapDeletionAudit(site),
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
  };
}

function mapSiteDomain(domain: {
  id: string;
  siteId: string;
  host: string;
  status: SiteDomain["status"];
  isPrimary: boolean;
  canonicalHost: string | null;
  verificationToken: string | null;
  verifiedAt: Date | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SiteDomain {
  return {
    id: domain.id,
    siteId: domain.siteId,
    host: domain.host,
    status: domain.status,
    isPrimary: domain.isPrimary,
    canonicalHost: domain.canonicalHost,
    verificationToken: domain.verificationToken,
    verifiedAt: domain.verifiedAt,
    ...mapDeletionAudit(domain),
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
  };
}

function mapSiteApp(app: {
  id: string;
  siteId: string;
  appKey: string;
  surface: SiteApp["surface"];
  status: SiteApp["status"];
  defaultRoute: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SiteApp {
  return {
    id: app.id,
    siteId: app.siteId,
    appKey: app.appKey,
    surface: app.surface,
    status: app.status,
    defaultRoute: app.defaultRoute,
    ...mapDeletionAudit(app),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

function mapSitePolicy(policy: {
  id: string;
  siteId: string;
  key: string;
  value: Prisma.JsonValue;
  status: SitePolicy["status"];
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SitePolicy {
  return {
    id: policy.id,
    siteId: policy.siteId,
    key: policy.key,
    value: policy.value,
    status: policy.status,
    ...mapDeletionAudit(policy),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function mapSiteFeatureFlag(flag: {
  id: string;
  siteId: string;
  key: string;
  enabled: boolean;
  metadata: Prisma.JsonValue | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  deleteReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SiteFeatureFlag {
  return {
    id: flag.id,
    siteId: flag.siteId,
    key: flag.key,
    enabled: flag.enabled,
    metadata: asJsonObject(flag.metadata),
    ...mapDeletionAudit(flag),
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
  };
}

// metadata 仅由 JsonObject 写入；非对象 JSON 视为缺省，归一为 null。
function asJsonObject(value: Prisma.JsonValue | null): JsonObject | null {
  const coerced = coerceJsonValue(value);
  return coerced !== null && typeof coerced === "object" && !Array.isArray(coerced) ? coerced : null;
}
