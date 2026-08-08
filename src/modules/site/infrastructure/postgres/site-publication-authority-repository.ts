import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { verifyCanonicalDocument, type CanonicalJsonValue } from
  "../../../product-catalog/domain/canonical-product-document.js";
import type { SitePublicationAuthorityRepository } from
  "../../application/contracts/site-publication-authority-ports.js";
import {
  createSiteWebBuildIntentDsseEnvelope,
  type SiteWebBuildIntentDsseEnvelope,
} from "../../domain/site-web-build-intent-dsse.js";
import {
  authorizeSiteReleaseCandidate,
  revokeSiteReleaseCandidateAuthorization,
  type CandidateAuthorityBinding,
  type SitePublicationNode,
  type SitePublicationNodeKind,
  type SiteReleaseCandidateAuthority,
} from "../../domain/site-publication-authority.js";

interface CandidateRow extends Record<string, unknown> {
  candidateRef: string;
  candidateVersion: string;
  candidateAuthorizationEpoch: string;
  currentAuthorizationEpoch: string;
  candidateDigest: string;
  siteRef: string;
  environment: string;
  state: "authorized" | "revoked";
  profileRef: string;
  profileRevision: string;
  profileDigest: string;
  catalogRef: string;
  catalogRevision: string;
  catalogDigest: string;
  businessBindingsDigest: string;
  canonicalPayload: unknown;
  canonicalBytes: Uint8Array;
}
interface NodeRow extends Record<string, unknown> {
  publicationKind: SitePublicationNodeKind;
  revisionRef: string;
  revision: string;
  digest: string;
  candidateRef: string;
  candidateVersion: string;
  candidateAuthorizationEpoch: string;
  candidateDigest: string;
  siteRef: string;
  canonicalPayload: unknown;
  canonicalBytes: Uint8Array;
}
interface WebBuildIntentEnvelopeRow extends Record<string, unknown> {
  payloadType: unknown;
  payload: unknown;
  signingKeyId: unknown;
  signature: unknown;
}

export class PostgresSitePublicationAuthorityRepository
implements SitePublicationAuthorityRepository {
  async assertSiteCanPublish(
    transaction: PlatformTransaction,
    siteRef: string,
    environment: string,
  ): Promise<void> {
    const rows = await resolvePlatformTransaction(transaction).query<Record<string, unknown>>(
      `SELECT 1 FROM platform.site site
       WHERE site.site_ref=$1 AND site.state NOT IN ('decommissioning','decommissioned')
         AND EXISTS (
           SELECT 1 FROM platform.site_project_binding binding
           WHERE binding.site_ref=site.site_ref AND binding.environment=$2 AND binding.state='active'
         )
       FOR UPDATE`, [siteRef, environment],
    );
    if (rows.length !== 1) throw new Error("SITE_PUBLICATION_OWNER_UNAVAILABLE");
  }

  async loadCandidateForUpdate(transaction: PlatformTransaction, candidateRef: string) {
    return queryCandidate(transaction, candidateRef, true);
  }

  async loadCandidate(transaction: PlatformTransaction, candidateRef: string) {
    return queryCandidate(transaction, candidateRef, false);
  }

  async insertCandidate(
    transaction: PlatformTransaction,
    candidate: SiteReleaseCandidateAuthority,
    commandId: string,
  ): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_release_candidate_authority
       (candidate_ref,candidate_version,candidate_authorization_epoch,candidate_digest,site_ref,
        environment,state,profile_ref,profile_revision,profile_digest,catalog_ref,catalog_revision,
        catalog_digest,business_bindings_digest,canonical_payload,canonical_bytes,
        authorized_by_command_id)
       VALUES ($1,$2::numeric(20,0),$3::numeric(20,0),$4,$5,$6,$7,$8,$9::numeric(20,0),$10,
               $11,$12::numeric(20,0),$13,$14,$15::jsonb,$16,$17)`,
      [candidate.binding.ref, candidate.binding.version.toString(),
        candidate.binding.authorizationEpoch.toString(), candidate.binding.digest,
        candidate.siteRef, candidate.environment, candidate.state,
        candidate.launchProductProfile.ref, candidate.launchProductProfile.revision.toString(),
        candidate.launchProductProfile.digest, candidate.productSurfaceCatalog.ref,
        candidate.productSurfaceCatalog.revision.toString(), candidate.productSurfaceCatalog.digest,
        candidate.businessBindingsDigest, JSON.stringify(candidate.document), candidate.canonicalBytes,
        commandId],
    );
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_release_candidate_authorization
       (candidate_ref,candidate_version,candidate_digest,authorization_epoch,state,updated_by_command_id)
       VALUES ($1,$2::numeric(20,0),$3,$4::numeric(20,0),'authorized',$5)`,
      [candidate.binding.ref, candidate.binding.version.toString(), candidate.binding.digest,
        candidate.binding.authorizationEpoch.toString(), commandId],
    );
  }

  async revokeCandidate(
    transaction: PlatformTransaction,
    input: Readonly<{
      candidate: CandidateAuthorityBinding;
      expectedAuthorizationEpoch: bigint;
      authorizationEpoch: bigint;
      commandId: string;
    }>,
  ): Promise<void> {
    const changed = await resolvePlatformTransaction(transaction).execute(
      `UPDATE platform.site_release_candidate_authorization
       SET authorization_epoch=$1::numeric(20,0),state='revoked',
           updated_by_command_id=$2,updated_at=clock_timestamp()
       WHERE candidate_ref=$3 AND candidate_version=$4::numeric(20,0)
         AND candidate_digest=$5 AND authorization_epoch=$6::numeric(20,0)
         AND state='authorized'`,
      [input.authorizationEpoch.toString(), input.commandId, input.candidate.ref,
        input.candidate.version.toString(), input.candidate.digest,
        input.expectedAuthorizationEpoch.toString()],
    );
    if (changed !== 1) throw new Error("SITE_PUBLICATION_CANDIDATE_REVOKE_CONFLICT");
  }

  async loadNode(
    transaction: PlatformTransaction,
    kind: SitePublicationNodeKind,
    candidateRef: string,
    candidateVersion: bigint,
  ): Promise<SitePublicationNode | null> {
    const rows = await resolvePlatformTransaction(transaction).query<NodeRow>(
      `SELECT publication_kind AS "publicationKind",revision_ref AS "revisionRef",
              revision::text,digest,candidate_ref AS "candidateRef",
              candidate_version::text AS "candidateVersion",
              candidate_authorization_epoch::text AS "candidateAuthorizationEpoch",
              candidate_digest AS "candidateDigest",site_ref AS "siteRef",
              canonical_payload AS "canonicalPayload",canonical_bytes AS "canonicalBytes"
       FROM platform.site_publication_revision
       WHERE publication_kind=$1 AND candidate_ref=$2
         AND candidate_version=$3::numeric(20,0)`,
      [kind, candidateRef, candidateVersion.toString()],
    );
    return rows[0] === undefined ? null : node(rows[0]);
  }

  async insertNode(
    transaction: PlatformTransaction,
    node: SitePublicationNode,
    producerKind: "operator-approved" | "platform-issued" | "workload-attested" | "certifier-signed",
    commandId: string,
  ): Promise<void> {
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_publication_revision
       (publication_kind,revision_ref,revision,digest,candidate_ref,candidate_version,
        candidate_authorization_epoch,candidate_digest,site_ref,producer_kind,canonical_payload,
        canonical_bytes,command_id)
       VALUES ($1,$2,$3::numeric(20,0),$4,$5,$6::numeric(20,0),$7::numeric(20,0),$8,$9,$10,
               $11::jsonb,$12,$13)`,
      [node.kind, node.binding.ref, node.binding.revision.toString(), node.binding.digest,
        node.candidate.ref, node.candidate.version.toString(), node.candidate.authorizationEpoch.toString(),
        node.candidate.digest, node.siteRef, producerKind, JSON.stringify(node.document),
        node.canonicalBytes, commandId],
    );
  }

  async loadWebBuildIntentEnvelope(
    transaction: PlatformTransaction,
    binding: Parameters<SitePublicationAuthorityRepository["loadWebBuildIntentEnvelope"]>[1],
  ): Promise<SiteWebBuildIntentDsseEnvelope | null> {
    const rows = await resolvePlatformTransaction(transaction).query<WebBuildIntentEnvelopeRow>(
      `SELECT payload_type AS "payloadType",payload,signing_key_id AS "signingKeyId",signature
       FROM platform.site_web_build_intent_envelope
       WHERE intent_ref=$1 AND intent_revision=$2::numeric(20,0) AND intent_digest=$3`,
      [binding.ref, binding.revision.toString(), binding.digest],
    );
    if (rows.length > 1) throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_CORRUPT");
    const row = rows[0];
    if (row === undefined) return null;
    try {
      return createSiteWebBuildIntentDsseEnvelope({
        payloadType: persistedText(row.payloadType),
        payload: persistedText(row.payload),
        signatures: [{
          keyid: persistedText(row.signingKeyId),
          sig: persistedText(row.signature),
        }],
      });
    } catch {
      throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_CORRUPT");
    }
  }

  async insertWebBuildIntentEnvelope(
    transaction: PlatformTransaction,
    binding: Parameters<SitePublicationAuthorityRepository["insertWebBuildIntentEnvelope"]>[1],
    envelope: Parameters<SitePublicationAuthorityRepository["insertWebBuildIntentEnvelope"]>[2],
    commandId: string,
  ): Promise<void> {
    const value = createSiteWebBuildIntentDsseEnvelope(envelope);
    await resolvePlatformTransaction(transaction).execute(
      `INSERT INTO platform.site_web_build_intent_envelope
       (intent_ref,intent_revision,intent_digest,payload_type,payload,signing_key_id,signature,command_id)
       VALUES ($1,$2::numeric(20,0),$3,$4,$5,$6,$7,$8)`,
      [binding.ref, binding.revision.toString(), binding.digest, value.payloadType, value.payload,
        value.signatures[0].keyid, value.signatures[0].sig, commandId],
    );
  }
}

async function queryCandidate(
  transaction: PlatformTransaction,
  candidateRef: string,
  forUpdate: boolean,
): Promise<SiteReleaseCandidateAuthority | null> {
  const rows = await resolvePlatformTransaction(transaction).query<CandidateRow>(
    `SELECT candidate.candidate_ref AS "candidateRef",
            candidate.candidate_version::text AS "candidateVersion",
            candidate.candidate_authorization_epoch::text AS "candidateAuthorizationEpoch",
            candidate_authorization.authorization_epoch::text AS "currentAuthorizationEpoch",
            candidate.candidate_digest AS "candidateDigest",candidate.site_ref AS "siteRef",
            candidate.environment,candidate_authorization.state,
            profile_ref AS "profileRef",profile_revision::text AS "profileRevision",
            profile_digest AS "profileDigest",catalog_ref AS "catalogRef",
            catalog_revision::text AS "catalogRevision",catalog_digest AS "catalogDigest",
            business_bindings_digest AS "businessBindingsDigest",
            canonical_payload AS "canonicalPayload",canonical_bytes AS "canonicalBytes"
     FROM platform.site_release_candidate_authority candidate
     JOIN platform.site_release_candidate_authorization candidate_authorization
       ON candidate_authorization.candidate_ref=candidate.candidate_ref
      AND candidate_authorization.candidate_version=candidate.candidate_version
     WHERE candidate.candidate_ref=$1 ORDER BY candidate.candidate_version DESC LIMIT 1
     ${forUpdate ? "FOR UPDATE OF candidate_authorization" : ""}`,
    [candidateRef],
  );
  return rows[0] === undefined ? null : candidate(rows[0]);
}

function candidate(row: CandidateRow): SiteReleaseCandidateAuthority {
  const resolved = authorizeSiteReleaseCandidate({
    siteRef: row.siteRef, environment: row.environment, candidateRef: row.candidateRef,
    expectedCandidateVersion: decimal(row.candidateVersion),
    candidateAuthorizationEpoch: decimal(row.candidateAuthorizationEpoch),
    launchProductProfile: { ref: row.profileRef, revision: decimal(row.profileRevision),
      digest: row.profileDigest },
    productSurfaceCatalog: { ref: row.catalogRef, revision: decimal(row.catalogRevision),
      digest: row.catalogDigest },
    businessBindingsDigest: row.businessBindingsDigest,
  }, { canonicalBytes: bytes(row.canonicalBytes), parsedDocument: row.canonicalPayload,
    digest: row.candidateDigest });
  if (row.state === "authorized") {
    if (row.currentAuthorizationEpoch !== row.candidateAuthorizationEpoch) {
      throw new Error("SITE_PUBLICATION_PERSISTED_CANDIDATE_EPOCH_INVALID");
    }
    return resolved;
  }
  const revoked = revokeSiteReleaseCandidateAuthorization(
    resolved,
    resolved.binding,
    decimal(row.candidateAuthorizationEpoch),
  ).candidate;
  if (revoked.binding.authorizationEpoch !== decimal(row.currentAuthorizationEpoch)) {
    throw new Error("SITE_PUBLICATION_PERSISTED_CANDIDATE_EPOCH_INVALID");
  }
  return revoked;
}

function node(row: NodeRow): SitePublicationNode {
  const verified = verifyCanonicalDocument({ canonicalBytes: bytes(row.canonicalBytes),
    parsedDocument: row.canonicalPayload, digest: row.digest });
  if (verified.digest !== row.digest) throw new Error("SITE_PUBLICATION_PERSISTED_NODE_DIGEST_INVALID");
  return Object.freeze({
    kind: row.publicationKind,
    binding: Object.freeze({ ref: row.revisionRef, revision: decimal(row.revision), digest: row.digest }),
    candidate: candidateBinding(row), siteRef: row.siteRef,
    document: verified.parsedDocument as CanonicalJsonValue,
    canonicalBytes: verified.canonicalBytes,
  });
}
function candidateBinding(row: NodeRow): CandidateAuthorityBinding {
  return Object.freeze({ ref: row.candidateRef, version: decimal(row.candidateVersion),
    authorizationEpoch: decimal(row.candidateAuthorizationEpoch), digest: row.candidateDigest });
}
function decimal(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("SITE_PUBLICATION_PERSISTED_DECIMAL_INVALID");
  return BigInt(value);
}
function bytes(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error("SITE_PUBLICATION_PERSISTED_BYTES_INVALID");
  return new Uint8Array(value);
}
function persistedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_CORRUPT");
  return value;
}
