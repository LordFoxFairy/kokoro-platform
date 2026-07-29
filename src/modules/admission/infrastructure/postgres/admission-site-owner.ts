import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdmissionOwnerResolution,
  AdmissionSiteOwnerPort,
} from "../../application/platform-admission-owner-authority.js";

interface ActiveSiteProjectRow extends Record<string, unknown> {
  readonly siteId: unknown;
  readonly projectRef: unknown;
  readonly configurationRevisionId: unknown;
  readonly policyDecisionRef: unknown;
  readonly localePolicy: unknown;
}

type SiteResolution = Awaited<ReturnType<AdmissionSiteOwnerPort["resolve"]>>;

/** Resolves only native Site-owned publication and project facts. */
export class PostgresAdmissionSiteOwner implements AdmissionSiteOwnerPort {
  async resolve(
    transaction: Parameters<AdmissionSiteOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionSiteOwnerPort["resolve"]>[1],
  ): Promise<SiteResolution> {
    const rows = await resolvePlatformTransaction(transaction).query<ActiveSiteProjectRow>(
      `SELECT site.site_ref AS "siteId",
              project.project_ref AS "projectRef",
              release.release_ref AS "configurationRevisionId",
              release.feature_policy_revision AS "policyDecisionRef",
              release.locale_policy AS "localePolicy"
         FROM platform.site AS site
         JOIN platform.site_release AS release
           ON release.site_ref=site.site_ref
          AND release.release_ref=site.active_release_ref
          AND release.state='active'
         JOIN platform.authorization_project AS project
           ON project.site_ref=site.site_ref
          AND project.project_ref=$2
          AND project.state='active'
        WHERE site.site_ref=$1
          AND site.state='active'
          AND site.tombstoned_at IS NULL
        LIMIT 1`,
      [input.siteId, input.projectRef],
    );
    const row = rows[0];
    if (row === undefined) return denied("ADMISSION_SITE_PROJECT_NOT_ACTIVE");
    if (rows.length !== 1) throw new Error("ADMISSION_SITE_OWNER_CORRUPT");
    if (row.siteId !== input.siteId || row.projectRef !== input.projectRef) {
      throw new Error("ADMISSION_SITE_OWNER_CORRUPT");
    }
    const localePolicy = parseLocalePolicy(row.localePolicy);
    if (!localePolicy.allowedLocales.includes(input.locale)) {
      return denied("ADMISSION_SITE_LOCALE_NOT_ALLOWED");
    }
    if (!boundedOwnerRef(row.configurationRevisionId) || !boundedOwnerRef(row.policyDecisionRef)) {
      throw new Error("ADMISSION_SITE_OWNER_CORRUPT");
    }
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({
        configurationRevisionId: row.configurationRevisionId,
        policyDecisionRef: row.policyDecisionRef,
      }),
    });
  }
}

function parseLocalePolicy(value: unknown): Readonly<{
  defaultLocale: string;
  allowedLocales: readonly string[];
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ADMISSION_SITE_LOCALE_POLICY_CORRUPT");
  }
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).sort().join(",") !== "allowedLocales,defaultLocale") {
    throw new Error("ADMISSION_SITE_LOCALE_POLICY_CORRUPT");
  }
  if (!validLocale(policy.defaultLocale) || !Array.isArray(policy.allowedLocales)) {
    throw new Error("ADMISSION_SITE_LOCALE_POLICY_CORRUPT");
  }
  const allowedLocales = policy.allowedLocales;
  if (
    allowedLocales.length < 1 || allowedLocales.length > 32 ||
    allowedLocales.some((locale) => !validLocale(locale)) ||
    new Set(allowedLocales).size !== allowedLocales.length ||
    !allowedLocales.includes(policy.defaultLocale)
  ) throw new Error("ADMISSION_SITE_LOCALE_POLICY_CORRUPT");
  return Object.freeze({
    defaultLocale: policy.defaultLocale,
    allowedLocales: Object.freeze([...allowedLocales]),
  });
}

function validLocale(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function boundedOwnerRef(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    });
}

function denied(code: string): AdmissionOwnerResolution<never> {
  return Object.freeze({
    kind: "denied",
    denial: Object.freeze({ code, retryClass: AdmissionRetryClass.NEVER }),
  });
}
