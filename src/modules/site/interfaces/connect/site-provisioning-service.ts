import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../interfaces/connect/generated-site-provisioning/kokoro/common/v2/command_envelope_pb.js";
import type { AuthenticatedOperatorCommandContext } from
  "../../../../interfaces/connect/generated-site-provisioning/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  ProvisionedSiteState,
  PublishedSiteReleaseState,
  SiteProvisioningService,
} from
  "../../../../interfaces/connect/generated-site-provisioning/kokoro/platform/site/v1/site_provisioning_pb.js";
import {
  publishSiteReleaseRequestDigest,
  registerSiteRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-site-provisioning/command-envelope-digest.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { ControlCommandReceiptTimestampReader } from
  "../../../admin/infrastructure/postgres/control-command-receipt-reader.js";
import type { SitePublicationService } from
  "../../application/services/site-publication-service.js";

export type SiteProvisioningConnectService = ServiceImpl<typeof SiteProvisioningService>;

export interface SiteProvisioningAdminResolver {
  resolveSiteProvisioningCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: "site.register" | "site.release.publish";
      siteRef: string;
      resourceRefs: readonly string[];
      scope: "global" | "site";
    }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>>;
}

export function createSiteProvisioningConnectService(input: Readonly<{
  owner: Pick<SitePublicationService, "registerSite" | "publishRelease">;
  resolver: SiteProvisioningAdminResolver;
  receipts: ControlCommandReceiptTimestampReader;
}>): SiteProvisioningConnectService {
  return {
    async registerSite(request, transport) {
      const context = required(request.context, "SITE_PROVISIONING_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_REGISTRATION_EFFECT_REQUIRED");
      const verified = await input.resolver.resolveSiteProvisioningCommand(context, transport, {
        operation: "site.register",
        siteRef: request.siteId,
        resourceRefs: [request.siteId, effect.projectBindingRef, effect.repositoryRef,
          effect.providerProjectRef, effect.workloadIdentityRef],
        scope: "global",
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        registerSiteRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await commandEffect(() => input.owner.registerSite({
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        siteRef: request.siteId,
        siteKey: effect.siteKey,
        bindingRef: effect.projectBindingRef,
        repositoryRef: effect.repositoryRef,
        providerNamespace: effect.providerNamespace,
        providerProjectRef: effect.providerProjectRef,
        environment: siteEnvironment(verified.context.environment),
        workloadIdentityId: effect.workloadIdentityRef,
      }, verified.context));
      const recordedAt = await input.receipts.read(verified.context, {
        commandId: identity.commandId,
        operation: "site.register",
      });
      return {
        siteId: request.siteId,
        state: ProvisionedSiteState.PREVIEW_READY,
        replayed: result.replayed,
        receipt: wireReceipt(identity, "site.register", recordedAt),
      };
    },

    async publishSiteRelease(request, transport) {
      const context = required(request.context, "SITE_PROVISIONING_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_RELEASE_EFFECT_REQUIRED");
      const locale = required(effect.localePolicy, "SITE_RELEASE_LOCALE_POLICY_REQUIRED");
      const certification = required(effect.certification,
        "SITE_RELEASE_CERTIFICATION_PROOF_REQUIRED");
      const verified = await input.resolver.resolveSiteProvisioningCommand(context, transport, {
        operation: "site.release.publish",
        siteRef: request.siteId,
        resourceRefs: [request.siteId, effect.releaseRef, effect.launchProfileRef,
          effect.modelOptionCatalogRef, effect.agentCatalogRef],
        scope: "site",
      });
      const identity = commandIdentity(context);
      requireDigest(identity.requestDigest,
        publishSiteReleaseRequestDigest(context, request.siteId, effect, verified.axes));
      const result = await commandEffect(() => input.owner.publishRelease({
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        siteRef: request.siteId,
        releaseRef: effect.releaseRef,
        webArtifactDigest: effect.webArtifactDigest,
        releaseManifestDigest: effect.releaseManifestDigest,
        certificationDigest: effect.certificationDigest,
        launchProfileRef: effect.launchProfileRef,
        siteConfigRevisionRef: effect.siteConfigRevisionRef,
        legalRevisionRef: effect.legalRevisionRef,
        featurePolicyRevision: effect.featurePolicyRevision,
        modelOptionCatalogRef: effect.modelOptionCatalogRef,
        agentCatalogRef: effect.agentCatalogRef,
        identityIssuerLabel: effect.identityIssuerLabel,
        identityAuthStrengthPolicyRevision: effect.identityAuthStrengthPolicyRevision,
        enabledSurfaceIds: effect.enabledSurfaceIds,
        localePolicy: {
          defaultLocale: locale.defaultLocale,
          allowedLocales: locale.allowedLocales,
        },
        certificationProof: {
          signingKeyRef: certification.signingKeyRef,
          issuedAt: instant(certification.issuedAt,
            "SITE_RELEASE_CERTIFICATION_ISSUED_AT_REQUIRED"),
          expiresAt: instant(certification.expiresAt,
            "SITE_RELEASE_CERTIFICATION_EXPIRES_AT_REQUIRED"),
          signature: new Uint8Array(certification.signature),
        },
      }, verified.context));
      const recordedAt = await input.receipts.read(verified.context, {
        commandId: identity.commandId,
        operation: "site.release.publish",
      });
      return {
        siteId: request.siteId,
        releaseRef: effect.releaseRef,
        state: PublishedSiteReleaseState.READY,
        replayed: result.replayed,
        receipt: wireReceipt(identity, "site.release.publish", recordedAt),
      };
    },
  };
}

async function commandEffect<Result>(effect: () => Promise<Result>): Promise<Result> {
  try {
    return await effect();
  } catch (error) {
    if (error instanceof Error && error.message === "COMMAND_IDENTITY_CONFLICT") {
      throw new ConnectError("command identity conflict", Code.AlreadyExists);
    }
    if (error instanceof Error && error.message === "COMMAND_DIGEST_CONFLICT") {
      throw new ConnectError("command digest conflict", Code.AlreadyExists);
    }
    throw error;
  }
}

function commandIdentity(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "SITE_PROVISIONING_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("SITE_PROVISIONING_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

function wireReceipt(
  identity: ReturnType<typeof commandIdentity>,
  operation: "site.register" | "site.release.publish",
  recordedAt: string,
) {
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      digestAlgorithm: identity.digestAlgorithm,
      requestDigest: identity.requestDigest,
    }),
    operation,
    state: CommandReceiptStateV2.COMMITTED,
    recordedAt: timestampFromDate(new Date(recordedAt)),
  });
}

function instant(
  value: Readonly<{ seconds: bigint; nanos: number }> | undefined,
  code: string,
): string {
  if (value === undefined) throw new Error(code);
  const millis = Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(millis)) throw new Error(code);
  return new Date(millis).toISOString();
}

function siteEnvironment(value: string): "development" | "preview" | "production" {
  if (value !== "development" && value !== "preview" && value !== "production") {
    throw new Error("SITE_PROVISIONING_ENVIRONMENT_INVALID");
  }
  return value;
}

function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("SITE_PROVISIONING_COMMAND_DIGEST_INVALID");
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}
