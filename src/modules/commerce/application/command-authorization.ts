import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";

export interface CommerceEffectAuthority {
  readonly siteId: string;
  readonly releaseRef: string;
  readonly subjectId: string;
}

export type CommerceCommandAuthoritySnapshot = Readonly<{
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
}>;

export type CommerceCommandAuthorityKey = Readonly<{
  workloadIdentityId: string;
  siteId: string;
  subjectId: string;
  sessionId: string;
}>;

export interface CommerceCommandAuthorityReader {
  lockCurrent(
    transaction: PlatformTransaction,
    key: CommerceCommandAuthorityKey,
  ): Promise<CommerceCommandAuthoritySnapshot | undefined>;
  readCurrent(
    transaction: PlatformTransaction,
    key: CommerceCommandAuthorityKey,
  ): Promise<CommerceCommandAuthoritySnapshot | undefined>;
}

export type CommerceCommandAuthorizer = (
  transaction: PlatformTransaction,
  context: VerifiedRequestSecurityContext,
  operation: string,
  now: string,
) => Promise<CommerceEffectAuthority>;

export type CommerceReadAuthorizer = CommerceCommandAuthorizer;

export interface CommerceCommandAuthorization {
  readonly authorizeCommand: CommerceCommandAuthorizer;
  readonly authorizeRead: CommerceReadAuthorizer;
}

export function createCommerceCommandAuthorization(
  authority: CommerceCommandAuthorityReader,
): CommerceCommandAuthorization {
  const authorizeCommand: CommerceCommandAuthorizer = (transaction, context, operation, now) =>
    authorizeCommerceCommand(authority, transaction, context, operation, now);
  const authorizeRead: CommerceReadAuthorizer = (transaction, context, operation, now) =>
    authorizeCommerceRead(authority, transaction, context, operation, now);
  return Object.freeze({ authorizeCommand, authorizeRead });
}

async function authorizeCommerceCommand(
  authority: CommerceCommandAuthorityReader,
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

  const snapshot = await authority.lockCurrent(transaction, {
    workloadIdentityId: context.trustedCaller.workloadIdentityId,
    siteId: callerSite,
    subjectId: context.actor.subjectId,
    sessionId,
  });
  return validateAuthority(snapshot, context, callerSite, now);
}

async function authorizeCommerceRead(
  authority: CommerceCommandAuthorityReader,
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
  const snapshot = await authority.readCurrent(transaction, {
    workloadIdentityId: context.trustedCaller.workloadIdentityId,
    siteId: callerSite,
    subjectId: context.actor.subjectId,
    sessionId,
  });
  return validateAuthority(snapshot, context, callerSite, now);
}

function validateAuthority(
  row: CommerceCommandAuthoritySnapshot | undefined,
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
