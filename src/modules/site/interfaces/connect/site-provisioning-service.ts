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
  SiteProvisioningService,
} from
  "../../../../interfaces/connect/generated-site-provisioning/kokoro/platform/site/v1/site_provisioning_pb.js";
import {
  registerSiteRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-site-provisioning/command-envelope-digest.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { ControlCommandReceiptTimestampReader } from
  "../../../admin/infrastructure/postgres/control-command-receipt-reader.js";
import type { SitePublicationService } from
  "../../application/services/site-publication-service.js";
import { withCommandReceiptConflictMapping } from
  "../../../../interfaces/connect/command-receipt-conflict.js";

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
  owner: Pick<SitePublicationService, "registerSite">;
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
      const result = await withCommandReceiptConflictMapping(() => input.owner.registerSite({
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

    async publishSiteRelease() {
      throw new ConnectError(
        "site release candidate authority not activated",
        Code.Unimplemented,
      );
    },
  };
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
  operation: "site.register",
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
