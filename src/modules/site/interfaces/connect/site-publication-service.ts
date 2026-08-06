import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../generated/proto/kokoro/common/v2/command_envelope_pb.js";
import type { AuthenticatedOperatorCommandContext } from
  "../../../../generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  CandidateAuthorityBindingSchema,
  ImmutableContractRevisionBindingSchema,
  type CandidateAuthorityBinding as WireCandidate,
  type ImmutableContractRevisionBinding as WireRevision,
} from "../../../../generated/proto/kokoro/platform/publication/v1/publication_common_pb.js";
import {
  PublishedSiteReleaseState,
  SiteReleaseCandidateAuthorizationState,
  SitePublicationService as SitePublicationDescriptor,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_publication_pb.js";
import {
  authorizeSiteReleaseCandidateRequestDigest,
  publishReleaseCertificationRequestDigest,
  publishSiteReleaseRequestDigest,
  publishSurfaceInventoryRequestDigest,
  publishWebBuildMaterialBundleRequestDigest,
  revokeSiteReleaseCandidateRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../generated/contracts/platform-site-publication@v1/digest.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { ControlCommandReceiptTimestampReader } from
  "../../../admin/infrastructure/postgres/control-command-receipt-reader.js";
import type { SitePublicationAuthorityService } from
  "../../application/services/site-publication-authority-service.js";
import type {
  CandidateAuthorityBinding as DomainCandidate,
  ImmutableRevisionBinding,
} from "../../domain/site-publication-authority.js";

export type SitePublicationConnectService = ServiceImpl<typeof SitePublicationDescriptor>;
export type SitePublicationAdminOperation =
  | "site.release-candidate.authorize" | "site.release-candidate.revoke"
  | "site.surface-inventory.publish"
  | "site.web-build-material-bundle.publish" | "site.web-build-intent.publish"
  | "site.release-certification.publish" | "site.release.publish";

export interface SitePublicationAdminResolver {
  resolveSitePublicationCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{ operation: SitePublicationAdminOperation; siteRef: string;
      resourceRefs: readonly string[] }>,
  ): Promise<Readonly<{ context: VerifiedRequestSecurityContext; axes: VerifiedAuthenticatedAdminAxes }>>;
}

export function createSitePublicationConnectService(input: Readonly<{
  owner: Pick<SitePublicationAuthorityService,
    "authorizeCandidate" | "revokeCandidate" | "publishNode" | "publishRelease">;
  resolver: SitePublicationAdminResolver;
  receipts: ControlCommandReceiptTimestampReader;
}>): SitePublicationConnectService {
  return {
    async authorizeSiteReleaseCandidate(request, transport) {
      const context = required(request.context, "SITE_PUBLICATION_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      const profile = required(effect.launchProductProfile, "SITE_PUBLICATION_PROFILE_REQUIRED");
      const catalog = required(effect.productSurfaceCatalog, "SITE_PUBLICATION_CATALOG_REQUIRED");
      const verified = await resolve(input, context, transport, "site.release-candidate.authorize",
        request.siteId, [effect.candidateRef, profile.ref, catalog.ref]);
      const identity = identityOf(context);
      requireDigest(identity.requestDigest,
        authorizeSiteReleaseCandidateRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await input.owner.authorizeCandidate({
        commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
        siteRef: request.siteId, candidateRef: effect.candidateRef,
        expectedCandidateVersion: effect.expectedCandidateVersion,
        candidateAuthorizationEpoch: effect.candidateAuthorizationEpoch,
        launchProductProfile: revision(profile), productSurfaceCatalog: revision(catalog),
        businessBindingsDigest: effect.businessBindingsDigest, reason: effect.reason,
      }, verified.context);
      return { candidate: wireCandidate(result.candidate), replayed: result.replayed,
        receipt: await receipt(input, verified.context, identity, "site.release-candidate.authorize") };
    },

    async revokeSiteReleaseCandidate(request, transport) {
      const context = required(request.context, "SITE_PUBLICATION_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      const candidate = required(effect.candidate, "SITE_PUBLICATION_CANDIDATE_REQUIRED");
      const verified = await resolve(input, context, transport, "site.release-candidate.revoke",
        request.siteId, [candidate.candidateRef]);
      const identity = identityOf(context);
      requireDigest(identity.requestDigest,
        revokeSiteReleaseCandidateRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await input.owner.revokeCandidate({
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        siteRef: request.siteId,
        candidate: candidateBinding(candidate),
        expectedAuthorizationEpoch: effect.expectedAuthorizationEpoch,
        reason: effect.reason,
      }, verified.context);
      return {
        candidate: wireCandidate(result.candidate),
        previousAuthorizationEpoch: result.previousAuthorizationEpoch,
        authorizationEpoch: result.authorizationEpoch,
        state: SiteReleaseCandidateAuthorizationState.REVOKED,
        replayed: result.replayed,
        receipt: await receipt(
          input,
          verified.context,
          identity,
          "site.release-candidate.revoke",
          "kokoro.platform.site.v1.SitePublicationService/RevokeSiteReleaseCandidate",
        ),
      };
    },

    async publishSurfaceInventory(request, transport) {
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      return publishNode(input, request.context, transport, request.siteId, effect,
        effect.surfaceInventory, "surface-inventory", "operator-approved",
        publishSurfaceInventoryRequestDigest);
    },

    async publishWebBuildMaterialBundle(request, transport) {
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      return publishNode(input, request.context, transport, request.siteId, effect,
        effect.webBuildMaterialBundle, "web-build-material-bundle", "operator-approved",
        publishWebBuildMaterialBundleRequestDigest);
    },

    async issueWebBuildIntent(request, transport) {
      // Root v1 incorrectly requires a caller-authored digest for a document
      // whose issuer heads and issuedAt are Platform-owned. Do not manufacture
      // a caller-compatible payload; the hard-cut v2 contract must remove it.
      void request;
      void transport;
      throw new ConnectError("SITE_WEB_BUILD_INTENT_CONTRACT_HARD_CUT_REQUIRED", Code.FailedPrecondition);
    },

    async publishReleaseCertification(request, transport) {
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      if (effect.expectedCertificationRevocationEpoch !== 0n) {
        throw new Error("SITE_PUBLICATION_CERTIFICATION_EPOCH_MUST_BE_LIVE_ZERO");
      }
      return publishNode(input, request.context, transport, request.siteId, effect,
        effect.releaseCertification, "release-certification", "certifier-signed",
        publishReleaseCertificationRequestDigest);
    },

    async publishSiteRelease(request, transport) {
      const context = required(request.context, "SITE_PUBLICATION_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_PUBLICATION_EFFECT_REQUIRED");
      const candidate = required(effect.candidate, "SITE_PUBLICATION_CANDIDATE_REQUIRED");
      const verified = await resolve(input, context, transport, "site.release.publish", request.siteId,
        [candidate.candidateRef]);
      const identity = identityOf(context);
      requireDigest(identity.requestDigest,
        publishSiteReleaseRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await input.owner.publishRelease({ commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey, siteRef: request.siteId,
        candidate: candidateBinding(candidate), reason: effect.reason }, verified.context);
      return { siteId: request.siteId, state: PublishedSiteReleaseState.READY,
        replayed: result.replayed, siteRelease: wireRevision(result.binding),
        receipt: await receipt(input, verified.context, identity, "site.release.publish") };
    },
  };
}

async function publishNode<Effect extends Readonly<{
  candidate?: WireCandidate | undefined;
  reason: string;
}>>(
  input: Parameters<typeof createSitePublicationConnectService>[0],
  claimed: AuthenticatedOperatorCommandContext | undefined,
  transport: HandlerContext,
  siteRef: string,
  effect: Effect,
  revisionValue: WireRevision | undefined,
  kind: "surface-inventory" | "web-build-material-bundle" | "web-build-intent" |
    "release-certification",
  producerKind: Parameters<SitePublicationAuthorityService["publishNode"]>[0]["producerKind"],
  digestFn: (context: AuthenticatedOperatorCommandContext, siteId: string, effect: Effect,
    axes: VerifiedAuthenticatedAdminAxes) => string,
) {
  const context = required(claimed, "SITE_PUBLICATION_CONTEXT_REQUIRED");
  const candidate = required(effect.candidate, "SITE_PUBLICATION_CANDIDATE_REQUIRED");
  const binding = required(revisionValue, "SITE_PUBLICATION_REVISION_REQUIRED");
  const operation = operationFor(kind);
  const verified = await resolve(input, context, transport, operation, siteRef,
    [candidate.candidateRef, binding.ref]);
  const identity = identityOf(context);
  requireDigest(identity.requestDigest, digestFn(context, siteRef, effect, verified.axes));
  const result = await input.owner.publishNode({ commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey, siteRef, kind,
    candidate: candidateBinding(candidate), binding: revision(binding), reason: effect.reason, producerKind,
  }, verified.context);
  return { [responseField(kind)]: wireRevision(result.binding), replayed: result.replayed,
    receipt: await receipt(input, verified.context, identity, operation) };
}

function operationFor(kind: string): SitePublicationAdminOperation {
  if (kind === "surface-inventory") return "site.surface-inventory.publish";
  if (kind === "web-build-material-bundle") return "site.web-build-material-bundle.publish";
  if (kind === "web-build-intent") return "site.web-build-intent.publish";
  return "site.release-certification.publish";
}
function responseField(kind: string): string {
  if (kind === "surface-inventory") return "surfaceInventory";
  if (kind === "web-build-material-bundle") return "webBuildMaterialBundle";
  if (kind === "web-build-intent") return "webBuildIntent";
  return "releaseCertification";
}
async function resolve(input: Parameters<typeof createSitePublicationConnectService>[0],
  context: AuthenticatedOperatorCommandContext, transport: HandlerContext,
  operation: SitePublicationAdminOperation, siteRef: string, resourceRefs: readonly string[]) {
  return input.resolver.resolveSitePublicationCommand(context, transport, { operation, siteRef, resourceRefs });
}
function identityOf(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "SITE_PUBLICATION_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("SITE_PUBLICATION_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}
function revision(value: WireRevision): ImmutableRevisionBinding {
  return Object.freeze({ ref: value.ref, revision: value.revision, digest: value.digest });
}
function candidateBinding(value: WireCandidate): DomainCandidate {
  return Object.freeze({ ref: value.candidateRef, version: value.candidateVersion,
    authorizationEpoch: value.candidateAuthorizationEpoch, digest: value.candidateDigest });
}
function wireRevision(value: ImmutableRevisionBinding) {
  return create(ImmutableContractRevisionBindingSchema, value);
}
function wireCandidate(value: DomainCandidate) {
  return create(CandidateAuthorityBindingSchema, {
    candidateRef: value.ref,
    candidateVersion: value.version,
    candidateAuthorizationEpoch: value.authorizationEpoch,
    candidateDigest: value.digest,
  });
}
async function receipt(input: Parameters<typeof createSitePublicationConnectService>[0],
  context: VerifiedRequestSecurityContext, identity: ReturnType<typeof identityOf>,
  operation: SitePublicationAdminOperation, receiptOperation: string = operation) {
  const recordedAt = await input.receipts.read(context, { commandId: identity.commandId, operation });
  return create(CommandReceiptV2Schema, { identity: create(CommandIdentityV2Schema, identity),
    operation: receiptOperation,
    state: CommandReceiptStateV2.COMMITTED, recordedAt: timestampFromDate(canonicalDate(recordedAt)) });
}
function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("SITE_PUBLICATION_REQUEST_DIGEST_MISMATCH");
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new ConnectError(code, Code.InvalidArgument);
  return value;
}
function canonicalDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new Error("SITE_PUBLICATION_RECEIPT_TIME_INVALID");
  }
  return date;
}
