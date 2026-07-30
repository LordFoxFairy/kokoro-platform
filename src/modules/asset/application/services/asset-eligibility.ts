import type { AdmissionCaller } from "../../../admission/application/admission-ports.js";
import {
  resourceAuthorizesSession,
  type SessionAccessGrantVerifierPort,
} from "../../../authorization/application/contracts/session-access-grant-verifier.js";
import { CHAT_ATTACHMENT_PURPOSE } from "../../domain/asset-purpose.js";
import type { AssetOwnerAuthority } from "../asset-user-authority.js";
import type { AssetAttachmentIntent } from "../contracts/asset-owner-query-ports.js";
import type { AssetOwnerQueryService, ReadySessionAttachmentView } from "./asset-owner-query.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";

const CONTRACT_REVISION = "platform-asset-eligibility@v1";
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const MAX_ATTACHMENTS = 64;

export type AssetEligibilityErrorCode =
  | "CALLER_NOT_AUTHORIZED"
  | "INPUT_INVALID"
  | "NOT_ACCEPTED"
  | "REQUEST_CANCELED";

export class AssetEligibilityError extends Error {
  constructor(readonly code: AssetEligibilityErrorCode) {
    super(code === "NOT_ACCEPTED" ? "ASSET_ELIGIBILITY_NOT_ACCEPTED" : `ASSET_ELIGIBILITY_${code}`);
    this.name = "AssetEligibilityError";
  }
}

export interface AssetEligibilityUnitOfWorkPort {
  checkActive(caller: AdmissionCaller): Promise<void>;
  execute<Result>(
    input: Readonly<{ siteId: string; caller: AdmissionCaller }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
  scopeOwner(
    transaction: PlatformTransaction,
    input: AssetOwnerAuthority & Readonly<{ purpose: string }>,
  ): Promise<void>;
}

export interface ResolveSessionAttachmentsInput {
  readonly siteId: string;
  readonly sessionAccessGrant: string;
  readonly sessionId: string;
  readonly purpose: string;
  readonly attachments: readonly AssetAttachmentIntent[];
}

export class AssetEligibilityApplicationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetEligibilityUnitOfWorkPort;
    verifier: SessionAccessGrantVerifierPort;
    assetQueries: Pick<AssetOwnerQueryService, "resolveSessionAttachments">;
    sessionCallerIdentity: string;
  }>) {
    if (!reference(dependencies.sessionCallerIdentity, 512) ||
        !dependencies.sessionCallerIdentity.startsWith("spiffe://")) {
      throw new Error("ASSET_ELIGIBILITY_SESSION_CALLER_IDENTITY_INVALID");
    }
  }

  async checkActive(
    caller: AdmissionCaller,
    signal: AbortSignal,
  ): Promise<Readonly<{ contractRevision: string }>> {
    this.assertCaller(caller);
    assertNotCanceled(signal);
    await this.dependencies.unitOfWork.checkActive(caller);
    assertNotCanceled(signal);
    return Object.freeze({ contractRevision: CONTRACT_REVISION });
  }

  async resolveSessionAttachments(
    input: ResolveSessionAttachmentsInput,
    caller: AdmissionCaller,
    signal: AbortSignal,
  ): Promise<readonly ReadySessionAttachmentView[]> {
    this.assertCaller(caller);
    validateInput(input);
    assertNotCanceled(signal);
    try {
      return await this.dependencies.unitOfWork.execute(
        { siteId: input.siteId, caller },
        async (transaction) => {
          assertNotCanceled(signal);
          const grant = await this.dependencies.verifier.verify(transaction, {
            siteId: input.siteId,
            credential: input.sessionAccessGrant,
            purpose: "write",
            environment: caller.environment,
            region: caller.region,
          });
          if (grant === null || !resourceAuthorizesSession(grant.resource, input.sessionId)) {
            throw new AssetEligibilityError("NOT_ACCEPTED");
          }
          const authority: AssetOwnerAuthority = Object.freeze({
            siteRef: grant.siteId,
            subjectRef: grant.subjectRef,
            subjectGeneration: grant.subjectGeneration,
            projectRef: grant.projectRef,
          });
          await this.dependencies.unitOfWork.scopeOwner(transaction, {
            ...authority,
            purpose: CHAT_ATTACHMENT_PURPOSE,
          });
          assertNotCanceled(signal);
          return this.dependencies.assetQueries.resolveSessionAttachments({
            transaction,
            authority,
            purpose: CHAT_ATTACHMENT_PURPOSE,
            attachments: input.attachments,
          });
        },
      );
    } catch (error) {
      if (error instanceof AssetEligibilityError) throw error;
      if (error instanceof Error && error.message === "ASSET_NOT_ACCEPTED") {
        throw new AssetEligibilityError("NOT_ACCEPTED");
      }
      throw error;
    }
  }

  private assertCaller(caller: AdmissionCaller): void {
    if (caller.identity !== this.dependencies.sessionCallerIdentity) {
      throw new AssetEligibilityError("CALLER_NOT_AUTHORIZED");
    }
  }
}

function validateInput(input: ResolveSessionAttachmentsInput): void {
  if (
    !reference(input.siteId, 128) || !reference(input.sessionId, 128) ||
    input.purpose !== CHAT_ATTACHMENT_PURPOSE ||
    input.sessionAccessGrant.length < 1 ||
    Buffer.byteLength(input.sessionAccessGrant, "utf8") > MAX_CREDENTIAL_BYTES ||
    !Array.isArray(input.attachments) || input.attachments.length < 1 ||
    input.attachments.length > MAX_ATTACHMENTS ||
    input.attachments.some((attachment) =>
      !reference(attachment.assetRef, 256) || !reference(attachment.assetVersionRef, 256) ||
      !reference(attachment.assetGrantRef, 256))
  ) throw new AssetEligibilityError("INPUT_INVALID");
}

function reference(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength &&
    value.trim() === value;
}

function assertNotCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new AssetEligibilityError("REQUEST_CANCELED");
}
