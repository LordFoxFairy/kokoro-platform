import type { VerifiedRequestSecurityContext } from "../../shared/security-context/request-security-context.js";
import { resolvePlatformTransaction, type PlatformTransaction } from "../../shared/unit-of-work/platform-transaction.js";

export interface CommerceEffectAuthority {
  readonly siteId: string;
  readonly releaseRef: string;
  readonly subjectId: string;
}

type AuthorityRow = Record<string, unknown> & {
  readonly siteId: string;
  readonly releaseRef: string;
  readonly subjectId: string;
  readonly bindingEpoch: bigint;
  readonly securityEpoch: bigint;
  readonly policyEpoch: bigint;
  readonly subjectGeneration: bigint;
  readonly restrictionEpoch: bigint;
  readonly sessionEpoch: bigint;
  readonly bindingState: string;
  readonly siteState: string;
  readonly releaseState: string;
  readonly subjectState: string;
  readonly sessionState: string;
  readonly environment: string;
  readonly region: string;
  readonly audience: string;
  readonly expiresAt: Date;
};

export async function authorizeCommerceCommand(
  transaction: PlatformTransaction,
  context: VerifiedRequestSecurityContext,
  operation: string,
  now: string,
): Promise<CommerceEffectAuthority> {
  const callerSite = context.trustedCaller.siteId;
  const sessionId = context.actor.sessionId;
  if (
    !["previewRedemption", "confirmRedemption"].includes(operation) ||
    context.trustedCaller.kind !== "site_product" || callerSite === undefined ||
    context.actor.kind !== "user" || sessionId === undefined ||
    context.target.siteId !== callerSite || context.actor.sessionEpoch === undefined ||
    context.actor.restrictionEpoch === undefined || context.target.purpose !== operation ||
    !hasBoundaryCsrfEvidence(context)
  ) deny();

  const rows = await resolvePlatformTransaction(transaction).query<AuthorityRow>(`${AUTHORITY_SQL}\n  FOR UPDATE OF binding,site,release,subject,identity_session`, [
    context.trustedCaller.workloadIdentityId,
    callerSite,
    context.actor.subjectId,
    sessionId,
  ]);
  return validateAuthority(rows[0], context, callerSite, now);
}

export async function authorizeCommerceRead(
  transaction: PlatformTransaction,
  context: VerifiedRequestSecurityContext,
  operation: string,
  now: string,
): Promise<CommerceEffectAuthority> {
  const callerSite = context.trustedCaller.siteId;
  const sessionId = context.actor.sessionId;
  if (
    !["recoverRedemptionCommand", "getRedemptionReceipt", "getCreditGrant", "getCreditSummary", "getUsageDetail", "listAccountProducts"].includes(operation) ||
    context.trustedCaller.kind !== "site_product" || callerSite === undefined || context.actor.kind !== "user" ||
    sessionId === undefined || context.target.siteId !== callerSite || context.actor.sessionEpoch === undefined ||
    context.actor.restrictionEpoch === undefined || context.target.purpose !== operation
  ) deny();
  const rows = await resolvePlatformTransaction(transaction).query<AuthorityRow>(AUTHORITY_SQL, [
    context.trustedCaller.workloadIdentityId, callerSite, context.actor.subjectId, sessionId,
  ]);
  return validateAuthority(rows[0], context, callerSite, now);
}

function validateAuthority(
  row: AuthorityRow | undefined,
  context: VerifiedRequestSecurityContext,
  callerSite: string,
  now: string,
): CommerceEffectAuthority {
  if (
    row === undefined || row.siteId !== callerSite || row.releaseRef !== context.trustedCaller.siteReleaseRef || row.subjectId !== context.actor.subjectId ||
    row.bindingState !== "active" || row.siteState !== "active" || row.releaseState !== "active" ||
    row.subjectState !== "active" || row.sessionState !== "active" || row.expiresAt.getTime() <= Date.parse(now) ||
    row.environment !== context.environment || row.region !== context.region || row.audience !== context.audience ||
    row.bindingEpoch.toString() !== context.trustedCaller.bindingEpoch ||
    row.policyEpoch.toString() !== context.policyEpoch ||
    row.subjectGeneration.toString() !== context.actor.subjectGeneration ||
    row.restrictionEpoch.toString() !== context.actor.restrictionEpoch ||
    row.sessionEpoch.toString() !== context.actor.sessionEpoch ||
    row.securityEpoch.toString() !== context.trustedCaller.siteSecurityEpoch
  ) deny();
  return Object.freeze({ siteId: row.siteId, releaseRef: row.releaseRef, subjectId: row.subjectId });
}

function hasBoundaryCsrfEvidence(context: VerifiedRequestSecurityContext): boolean {
  return context.evidence.some((evidence) =>
    evidence.kind === "csrf_verification" &&
    evidence.issuer === "kokoro-platform-public" &&
    /^[a-f0-9]{64}$/u.test(evidence.evidenceId),
  );
}

function deny(): never {
  throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
}

const AUTHORITY_SQL = `
  SELECT binding.site_ref AS "siteId", binding.release_ref AS "releaseRef",
         subject.subject_ref AS "subjectId", binding.binding_epoch AS "bindingEpoch",
         site.security_epoch AS "securityEpoch", site.policy_epoch AS "policyEpoch",
         subject.subject_generation AS "subjectGeneration", subject.restriction_epoch AS "restrictionEpoch",
         identity_session.session_epoch AS "sessionEpoch", binding.state AS "bindingState",
         site.state AS "siteState", release.state AS "releaseState", subject.state AS "subjectState",
         identity_session.state AS "sessionState", binding.environment, binding.region, binding.audience,
         identity_session.expires_at AS "expiresAt"
  FROM platform.authorization_product_binding binding
  JOIN platform.authorization_site site ON site.site_ref=binding.site_ref
  JOIN platform.authorization_site_release release
    ON release.release_ref=binding.release_ref AND release.site_ref=binding.site_ref
  JOIN platform.authorization_subject subject
    ON subject.subject_ref=$3 AND subject.site_ref=binding.site_ref
  JOIN platform.authorization_identity_session identity_session
    ON identity_session.session_ref=$4 AND identity_session.subject_ref=subject.subject_ref
      AND identity_session.site_ref=binding.site_ref
  WHERE binding.workload_identity_id=$1 AND binding.site_ref=$2`;
