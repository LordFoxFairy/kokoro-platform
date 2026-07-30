import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";

export interface AssetOwnerAuthority {
  readonly siteRef: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint;
  readonly projectRef: string;
}

export interface AssetUserAuthority extends AssetOwnerAuthority {
  readonly workloadIdentityId: string;
  readonly siteReleaseRef: string;
  readonly bindingEpoch: bigint;
}

export function resolveAssetUserAuthority(
  context: VerifiedRequestSecurityContext,
  operation: string,
): AssetUserAuthority {
  const siteRef = context.trustedCaller.siteId;
  const siteReleaseRef = context.trustedCaller.siteReleaseRef;
  const projectRef = context.target.projectId;
  if (
    context.trustedCaller.kind !== "site_product" || siteRef === undefined ||
    siteReleaseRef === undefined || context.target.siteId !== siteRef || projectRef === null ||
    context.target.purpose !== operation || context.actor.kind !== "user" ||
    !context.trustedCaller.allowedOperations.includes(operation)
  ) throw new Error("ASSET_USER_AUTHORITY_INVALID");
  return Object.freeze({
    siteRef,
    workloadIdentityId: context.trustedCaller.workloadIdentityId,
    siteReleaseRef,
    bindingEpoch: positiveBigint(context.trustedCaller.bindingEpoch, "ASSET_BINDING_EPOCH_INVALID"),
    subjectRef: context.actor.subjectId,
    subjectGeneration: positiveBigint(context.actor.subjectGeneration, "ASSET_SUBJECT_GENERATION_INVALID"),
    projectRef,
  });
}

function positiveBigint(value: string, code: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(code);
  return BigInt(value);
}
