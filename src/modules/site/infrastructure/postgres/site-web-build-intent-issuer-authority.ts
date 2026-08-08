import { z } from "zod";
import type { SiteWebBuildIntentIssuerAuthorityPort } from
  "../../application/contracts/site-publication-authority-ports.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import {
  canonicalInstant,
  deepFreeze,
  digest,
  exactlyOne,
  positiveDecimal,
  reference,
} from "./site-publication-authority-codecs.js";

interface IntentAuthorityRow extends Record<string, unknown> {
  readonly webCompositionRegistryRef: unknown;
  readonly webCompositionRegistryRevision: unknown;
  readonly webCompositionRegistryDigest: unknown;
  readonly webBuildToolchainRef: unknown;
  readonly webBuildToolchainRevision: unknown;
  readonly webBuildToolchainDigest: unknown;
  readonly contractFloor: unknown;
  readonly issuerRef: unknown;
  readonly producerRegistryRef: unknown;
  readonly producerRegistryDigest: unknown;
  readonly producerRegistryEpoch: unknown;
  readonly trustPolicyRef: unknown;
  readonly trustPolicyDigest: unknown;
  readonly trustPolicyEpoch: unknown;
  readonly signingKeyId: unknown;
  readonly keyVersion: unknown;
  readonly publicKeyFingerprint: unknown;
  readonly keyValidFrom: unknown;
  readonly keyValidUntil: unknown;
}

const floorSchema = z.array(z.object({
  contractRef: z.string().min(3).max(256),
  minimumMajor: z.string().regex(/^[1-9][0-9]*$/u),
}).strict()).min(1).max(128).refine((values) =>
  new Set(values.map(({ contractRef }) => contractRef)).size === values.length);

export class PostgresSiteWebBuildIntentIssuerAuthority
implements SiteWebBuildIntentIssuerAuthorityPort {
  async resolve(
    transaction: Parameters<SiteWebBuildIntentIssuerAuthorityPort["resolve"]>[0],
    input: Parameters<SiteWebBuildIntentIssuerAuthorityPort["resolve"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<IntentAuthorityRow>(
      `SELECT authority.web_composition_registry_ref AS "webCompositionRegistryRef",
              authority.web_composition_registry_revision::text AS "webCompositionRegistryRevision",
              authority.web_composition_registry_digest AS "webCompositionRegistryDigest",
              authority.web_build_toolchain_ref AS "webBuildToolchainRef",
              authority.web_build_toolchain_revision::text AS "webBuildToolchainRevision",
              authority.web_build_toolchain_digest AS "webBuildToolchainDigest",
              authority.contract_floor AS "contractFloor",authority.issuer_ref AS "issuerRef",
              authority.producer_registry_ref AS "producerRegistryRef",
              authority.producer_registry_digest AS "producerRegistryDigest",
              authority.producer_registry_epoch::text AS "producerRegistryEpoch",
              authority.trust_policy_ref AS "trustPolicyRef",
              authority.trust_policy_digest AS "trustPolicyDigest",
              authority.trust_policy_epoch::text AS "trustPolicyEpoch",
              authority.signing_key_id AS "signingKeyId",
              authority.key_version::text AS "keyVersion",
              authority.public_key_fingerprint AS "publicKeyFingerprint",
              to_char(authority.key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
              to_char(authority.key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil"
       FROM platform.site_web_build_intent_issuer_head head
       JOIN platform.site_web_build_intent_issuer_revision authority
         ON authority.authority_ref=head.authority_ref
        AND authority.authority_revision=head.authority_revision
        AND authority.authority_digest=head.authority_digest
       WHERE head.site_ref=$1 AND head.environment=$2`,
      [input.siteRef, input.environment],
    );
    const row = exactlyOne(rows, "SITE_WEB_BUILD_INTENT_AUTHORITY_NOT_FOUND");
    return decoded(row);
  }

  async resolveExact(
    transaction: Parameters<SiteWebBuildIntentIssuerAuthorityPort["resolveExact"]>[0],
    input: Parameters<SiteWebBuildIntentIssuerAuthorityPort["resolveExact"]>[1],
  ) {
    const rows = await resolvePlatformTransaction(transaction).query<IntentAuthorityRow>(
      `SELECT authority.web_composition_registry_ref AS "webCompositionRegistryRef",
              authority.web_composition_registry_revision::text AS "webCompositionRegistryRevision",
              authority.web_composition_registry_digest AS "webCompositionRegistryDigest",
              authority.web_build_toolchain_ref AS "webBuildToolchainRef",
              authority.web_build_toolchain_revision::text AS "webBuildToolchainRevision",
              authority.web_build_toolchain_digest AS "webBuildToolchainDigest",
              authority.contract_floor AS "contractFloor",authority.issuer_ref AS "issuerRef",
              authority.producer_registry_ref AS "producerRegistryRef",
              authority.producer_registry_digest AS "producerRegistryDigest",
              authority.producer_registry_epoch::text AS "producerRegistryEpoch",
              authority.trust_policy_ref AS "trustPolicyRef",
              authority.trust_policy_digest AS "trustPolicyDigest",
              authority.trust_policy_epoch::text AS "trustPolicyEpoch",
              authority.signing_key_id AS "signingKeyId",
              authority.key_version::text AS "keyVersion",
              authority.public_key_fingerprint AS "publicKeyFingerprint",
              to_char(authority.key_valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidFrom",
              to_char(authority.key_valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "keyValidUntil"
       FROM platform.site_web_build_intent_issuer_revision authority
       WHERE authority.site_ref=$1 AND authority.environment=$2
         AND authority.signing_key_id=$3 AND authority.key_version=$4::numeric(20,0)
         AND authority.public_key_fingerprint=$5`,
      [input.siteRef, input.environment, input.key.keyId, input.key.keyVersion.toString(),
        input.key.publicKeyFingerprint],
    );
    return decoded(exactlyOne(rows, "SITE_WEB_BUILD_INTENT_AUTHORITY_NOT_FOUND"));
  }
}

function decoded(row: IntentAuthorityRow) {
  const parsedFloor = floorSchema.safeParse(row.contractFloor);
  if (!parsedFloor.success) throw new Error("SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT");
  return deepFreeze({
      webCompositionRegistry: {
        ref: reference(row.webCompositionRegistryRef, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        revision: positiveDecimal(row.webCompositionRegistryRevision,
          "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        digest: digest(row.webCompositionRegistryDigest, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      },
      webBuildToolchain: {
        ref: reference(row.webBuildToolchainRef, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        revision: positiveDecimal(row.webBuildToolchainRevision,
          "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        digest: digest(row.webBuildToolchainDigest, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      },
      contractFloor: parsedFloor.data.map((entry) => Object.freeze({
        contractRef: entry.contractRef,
        minimumMajor: positiveDecimal(entry.minimumMajor,
          "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      })),
      issuerRef: reference(row.issuerRef, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      producerRegistry: Object.freeze({
        ref: reference(row.producerRegistryRef, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        digest: digest(row.producerRegistryDigest, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      }),
      producerRegistryEpoch: positiveDecimal(row.producerRegistryEpoch,
        "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      trustPolicy: Object.freeze({
        ref: reference(row.trustPolicyRef, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
        digest: digest(row.trustPolicyDigest, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      }),
      trustPolicyEpoch: positiveDecimal(row.trustPolicyEpoch,
        "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      signingKeyId: reference(row.signingKeyId, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      keyVersion: positiveDecimal(row.keyVersion, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      publicKeyFingerprint: digest(row.publicKeyFingerprint,
        "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      keyValidFrom: canonicalInstant(row.keyValidFrom, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
      keyValidUntil: canonicalInstant(row.keyValidUntil, "SITE_WEB_BUILD_INTENT_AUTHORITY_CORRUPT"),
  });
}
