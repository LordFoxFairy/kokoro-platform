import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { createUploadIntent, createUploadSession } from "../../domain/upload-intent.js";
import { digestAssetCommand } from "../asset-digest.js";
import { resolveAssetUserAuthority } from "../asset-user-authority.js";
import type {
  AssetPolicyResolverPort,
  AssetUnitOfWorkPort,
  AssetUploadCapability,
  AssetUploadCapabilityIssuerPort,
  AssetUploadCommandReceiptPort,
  AssetUploadRepositoryPort,
} from "../contracts/asset-upload-ports.js";

const OPERATION = "createAssetUploadIntent";

export interface CreateUploadIntentResult {
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly state: "uploading";
  readonly expectedVersion: bigint;
  readonly safeDisplayName: string;
  readonly expectedSize: bigint;
  readonly expiresAt: string;
  readonly capability: AssetUploadCapability;
  readonly commandId: string;
}

export class CreateUploadIntentService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetUnitOfWorkPort;
    repository: AssetUploadRepositoryPort;
    policyResolver: AssetPolicyResolverPort;
    capabilityIssuer: AssetUploadCapabilityIssuerPort;
    receipts: AssetUploadCommandReceiptPort;
    clock?: () => Date;
    reference?: () => string;
  }>) {}

  async execute(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    purpose: string;
    filename: string;
    clientMediaType: string;
    expectedSize: bigint;
    expectedChecksumSha256: string;
  }>): Promise<CreateUploadIntentResult> {
    const authority = resolveAssetUserAuthority(input.context, OPERATION);
    bounded(input.idempotencyKey, 8, 128, "ASSET_IDEMPOTENCY_KEY_INVALID");
    const now = this.now();
    const policy = await this.dependencies.policyResolver.resolve({
      ...authority,
      purpose: input.purpose,
      clientMediaType: input.clientMediaType,
      expectedSize: input.expectedSize,
      now,
    });
    verifyPolicyResolution(policy, now);
    const requestDigest = digestAssetCommand({
      operation: OPERATION,
      siteRef: authority.siteRef,
      siteReleaseRef: authority.siteReleaseRef,
      bindingEpoch: authority.bindingEpoch,
      subjectRef: authority.subjectRef,
      subjectGeneration: authority.subjectGeneration,
      projectRef: authority.projectRef,
      purpose: input.purpose,
      filename: input.filename.normalize("NFKC"),
      clientMediaType: input.clientMediaType.trim().toLowerCase(),
      expectedSize: input.expectedSize,
      expectedChecksumSha256: input.expectedChecksumSha256,
    });
    const identity = Object.freeze({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      callerIdentity: `${authority.workloadIdentityId}:${authority.subjectRef}:${authority.subjectGeneration}`,
      operation: OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
    });
    const proposed = createUploadIntent({
      intentRef: this.reference(),
      ...authority,
      purpose: input.purpose,
      filename: input.filename,
      clientMediaType: input.clientMediaType,
      expectedSize: input.expectedSize,
      expectedChecksumSha256: input.expectedChecksumSha256,
      policy: policy.policy,
      now,
    });
    const proposedSession = createUploadSession({
      sessionRef: this.reference(),
      intent: proposed,
      quotaRevisionRef: policy.quotaRevisionRef,
      storageTenantRef: policy.storageTenantRef,
      storageRegion: policy.policy.storageRegion,
      quarantineObjectRef: `quarantine/${this.reference()}`,
      capabilityAudience: policy.uploadAudience,
      minimumPartBytes: policy.minimumPartBytes,
      maximumPartBytes: policy.maximumPartBytes,
      capabilityLifetimeSeconds: policy.capabilityLifetimeSeconds,
    });
    const claim = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: OPERATION },
      async (transaction) => {
        let receipt;
        try {
          receipt = await this.dependencies.receipts.begin(transaction, identity);
        } catch (error) {
          if (error instanceof Error && error.message === "COMMAND_DIGEST_CONFLICT") {
            throw new Error("ASSET_IDEMPOTENCY_DIGEST_CONFLICT");
          }
          throw error;
        }
        if (receipt.commandId !== input.commandId) throw new Error("ASSET_IDEMPOTENCY_DIGEST_CONFLICT");
        return this.dependencies.repository.claimUploadIntent(transaction, {
          intent: proposed,
          session: proposedSession,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          maximumInflightBytes: policy.policy.maximumInflightBytes,
          maximumReadyBytes: policy.policy.maximumReadyBytes,
        });
      },
    );
    if (claim.disposition === "conflict") throw new Error("ASSET_IDEMPOTENCY_DIGEST_CONFLICT");
    assertReplayAuthority(claim.intent, authority);
    if (claim.session.state !== "awaiting_capability" && claim.session.state !== "uploading") {
      throw new Error("ASSET_UPLOAD_INTENT_NOT_RENEWABLE");
    }
    const capabilityEpoch = claim.session.capabilityEpoch + 1n;
    const expiresAt = minimumExpiry(
      claim.session.expiresAt,
      new Date(Date.parse(now) + claim.session.capabilityLifetimeSeconds * 1000).toISOString(),
    );
    const capability = await this.dependencies.capabilityIssuer.issue({
      audience: claim.session.capabilityAudience,
      storageTenantRef: claim.session.storageTenantRef,
      storageRegion: claim.session.storageRegion,
      siteRef: claim.intent.siteRef,
      workloadIdentityId: claim.intent.workloadIdentityId,
      siteReleaseRef: claim.intent.siteReleaseRef,
      bindingEpoch: claim.intent.bindingEpoch,
      subjectRef: claim.intent.subjectRef,
      subjectGeneration: claim.intent.subjectGeneration,
      projectRef: claim.intent.projectRef,
      purpose: claim.intent.purpose,
      intentRef: claim.intent.intentRef,
      sessionRef: claim.session.sessionRef,
      quarantineObjectRef: claim.session.quarantineObjectRef,
      expectedSize: claim.intent.expectedSize,
      expectedChecksumSha256: claim.intent.expectedChecksumSha256,
      capabilityEpoch,
      expiresAt,
      minimumPartBytes: claim.session.minimumPartBytes,
      maximumPartBytes: claim.session.maximumPartBytes,
      allowedOrigins: policy.allowedOrigins,
    });
    assertCapability(capability, capabilityEpoch, expiresAt, claim.session);
    const issued = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: OPERATION },
      async (transaction) => {
        const session = await this.dependencies.repository.markCapabilityIssued(transaction, {
          siteRef: claim.intent.siteRef,
          intentRef: claim.intent.intentRef,
          expectedVersion: claim.session.expectedVersion,
          capabilityEpoch,
          expiresAt,
        });
        const result = Object.freeze({
          intentRef: claim.intent.intentRef,
          sessionRef: session.sessionRef,
        });
        await this.dependencies.receipts.recordOutcome(transaction, identity, {
          state: "succeeded",
          result,
          resultDigest: digestAssetCommand(result),
        });
        return session;
      },
    );
    return Object.freeze({
      intentRef: issued.intentRef,
      sessionRef: issued.sessionRef,
      state: "uploading" as const,
      expectedVersion: issued.expectedVersion,
      safeDisplayName: claim.intent.safeDisplayName,
      expectedSize: claim.intent.expectedSize,
      expiresAt: issued.expiresAt,
      capability,
      commandId: input.commandId,
    });
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }

  private reference(): string {
    return (this.dependencies.reference ?? (() => crypto.randomUUID()))();
  }
}

function verifyPolicyResolution(
  value: Awaited<ReturnType<AssetPolicyResolverPort["resolve"]>>,
  now: string,
): void {
  bounded(value.quotaRevisionRef, 3, 128, "ASSET_QUOTA_REVISION_INVALID");
  bounded(value.storageTenantRef, 3, 128, "ASSET_STORAGE_TENANT_INVALID");
  bounded(value.uploadAudience, 3, 256, "ASSET_UPLOAD_AUDIENCE_INVALID");
  if (
    value.minimumPartBytes < 1n || value.maximumPartBytes < value.minimumPartBytes ||
    value.allowedOrigins.length < 1 || value.allowedOrigins.length > 32 ||
    !Number.isInteger(value.capabilityLifetimeSeconds) || value.capabilityLifetimeSeconds < 30 ||
    value.capabilityLifetimeSeconds > 900 || Date.parse(value.policy.expiresAt) <= Date.parse(now)
  ) throw new Error("ASSET_POLICY_RESOLUTION_INVALID");
}

function assertReplayAuthority(
  intent: Readonly<{
    siteRef: string; workloadIdentityId: string; siteReleaseRef: string; bindingEpoch: bigint;
    subjectRef: string; subjectGeneration: bigint; projectRef: string;
  }>,
  authority: Readonly<{
    siteRef: string; workloadIdentityId: string; siteReleaseRef: string; bindingEpoch: bigint;
    subjectRef: string; subjectGeneration: bigint; projectRef: string;
  }>,
): void {
  if (
    intent.siteRef !== authority.siteRef || intent.workloadIdentityId !== authority.workloadIdentityId ||
    intent.siteReleaseRef !== authority.siteReleaseRef || intent.bindingEpoch !== authority.bindingEpoch ||
    intent.subjectRef !== authority.subjectRef ||
    intent.subjectGeneration !== authority.subjectGeneration || intent.projectRef !== authority.projectRef
  ) throw new Error("ASSET_UPLOAD_REPLAY_AUTHORITY_MISMATCH");
}

function assertCapability(
  capability: AssetUploadCapability,
  epoch: bigint,
  expiresAt: string,
  session: Readonly<{ minimumPartBytes: bigint; maximumPartBytes: bigint }>,
): void {
  if (
    capability.protocolRevision !== "s3-multipart-v1" || capability.capabilityEpoch !== epoch ||
    capability.expiresAt !== expiresAt || capability.minimumPartBytes !== session.minimumPartBytes ||
    capability.maximumPartBytes !== session.maximumPartBytes || capability.credential.length < 32 ||
    !capability.uploadEndpoint.startsWith("https://")
  ) throw new Error("ASSET_UPLOAD_CAPABILITY_INVALID");
}

function minimumExpiry(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum) throw new Error(code);
}
