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
import type { Site } from "../../domain/site.js";
import type { SiteApp } from "../../domain/site-app.js";
import type { SiteDomain } from "../../domain/site-domain.js";
import type { SiteFeatureFlag } from "../../domain/site-feature-flag.js";
import type { SitePolicy } from "../../domain/site-policy.js";

export class PrismaSiteRepository implements SiteRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertSite(input: UpsertSiteInput): Promise<Site> {
    const site = await this.prisma.site.upsert({
      where: {
        key: input.key,
      },
      create: {
        key: input.key,
        name: input.name,
        status: input.status ?? "draft",
        defaultLocale: input.defaultLocale ?? "zh-CN",
        timezone: input.timezone ?? "Asia/Shanghai",
        ...definedJson("metadata", input.metadata),
      },
      update: {
        name: input.name,
        ...definedValue("status", input.status),
        ...definedValue("defaultLocale", input.defaultLocale),
        ...definedValue("timezone", input.timezone),
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSite(site);
  }

  async upsertSiteDomain(input: UpsertSiteDomainInput): Promise<SiteDomain> {
    const domain = await this.prisma.siteDomain.upsert({
      where: {
        host: normalizeHost(input.host),
      },
      create: {
        siteId: input.siteId,
        host: normalizeHost(input.host),
        status: input.status ?? "active",
        isPrimary: input.isPrimary ?? false,
        canonicalHost: normalizeOptionalHost(input.canonicalHost),
        ...definedJson("metadata", input.metadata),
      },
      update: {
        siteId: input.siteId,
        ...definedValue("status", input.status),
        ...definedValue("isPrimary", input.isPrimary),
        ...definedNullableHost("canonicalHost", input.canonicalHost),
        ...definedJson("metadata", input.metadata),
      },
    });

    return mapSiteDomain(domain);
  }

  async upsertSiteApp(input: UpsertSiteAppInput): Promise<SiteApp> {
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
      where: { siteId },
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

    if (!domain || domain.status !== "active" || domain.site.status !== "active") {
      return null;
    }

    const app = domain.site.apps[0];

    return {
      site: mapSite(domain.site),
      app: app ? mapSiteApp(app) : undefined,
      context: {
        siteId: domain.site.id,
        siteKey: domain.site.key,
        host: domain.host,
        appKey: app?.appKey ?? input.appKey,
        surface: app?.surface ?? input.surface,
        defaultLocale: domain.site.defaultLocale,
        timezone: domain.site.timezone,
      },
    };
  }

  async listSites(): Promise<Site[]> {
    const sites = await this.prisma.site.findMany({
      orderBy: {
        createdAt: "asc",
      },
    });

    return sites.map(mapSite);
  }

  async listAdminSites(): Promise<Site[]> {
    const sites = await this.prisma.site.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return sites.map(mapSite);
  }

  async listAdminSiteDomains(): Promise<SiteDomain[]> {
    const domains = await this.prisma.siteDomain.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return domains.map(mapSiteDomain);
  }

  async listAdminSiteApps(): Promise<SiteApp[]> {
    const apps = await this.prisma.siteApp.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return apps.map(mapSiteApp);
  }

  async listAdminSitePolicies(): Promise<SitePolicy[]> {
    const policies = await this.prisma.sitePolicy.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return policies.map(mapSitePolicy);
  }

  async listAdminSiteFeatureFlags(): Promise<SiteFeatureFlag[]> {
    const flags = await this.prisma.siteFeatureFlag.findMany({
      orderBy: { createdAt: "desc" },
      take: ADMIN_LIST_LIMIT,
    });

    return flags.map(mapSiteFeatureFlag);
  }
}

const ADMIN_LIST_LIMIT = 100;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
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

function mapSite(site: {
  id: string;
  key: string;
  name: string;
  status: Site["status"];
  defaultLocale: string;
  timezone: string;
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
  createdAt: Date;
  updatedAt: Date;
}): SitePolicy {
  return {
    id: policy.id,
    siteId: policy.siteId,
    key: policy.key,
    value: policy.value,
    status: policy.status,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function mapSiteFeatureFlag(flag: {
  id: string;
  siteId: string;
  key: string;
  enabled: boolean;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): SiteFeatureFlag {
  return {
    id: flag.id,
    siteId: flag.siteId,
    key: flag.key,
    enabled: flag.enabled,
    metadata: asJsonObject(flag.metadata),
    createdAt: flag.createdAt,
    updatedAt: flag.updatedAt,
  };
}

// metadata 仅由 JsonObject 写入；非对象 JSON 视为缺省，归一为 null。
function asJsonObject(value: Prisma.JsonValue): JsonObject | null {
  const coerced = coerceJsonValue(value);
  return coerced !== null && typeof coerced === "object" && !Array.isArray(coerced) ? coerced : null;
}
