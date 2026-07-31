import { randomUUID } from "node:crypto";
import type {
  ArtifactPage,
  ArtifactResponse,
  ArtifactVersion,
  ArtifactVersionPage,
  ArtifactVersionResponse,
  ArtifactDeliveryAuthorizationInput,
  ArtifactDeliveryAuthorizationResponse,
  ArtifactDeliveryRevocationResponse,
  ArtifactSummary,
} from "../../../interfaces/http/generated/platform-public/types.gen.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../shared/unit-of-work/unit-of-work.js";
import type {
  ArtifactDeliveryCapabilityCodecPort,
  ArtifactOwnerCursorCodec,
  ArtifactPublicRepository,
  ArtifactSummaryRecord,
  ArtifactVersionRecord,
} from "./contracts.js";

const MAXIMUM_TTL_MS = 5 * 60 * 1_000;

export class ArtifactPublicOwnerService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: ArtifactPublicRepository;
    deliveryCapabilities: Pick<ArtifactDeliveryCapabilityCodecPort, "issue">;
    cursors: ArtifactOwnerCursorCodec;
    clock?: () => Date;
    reference?: () => string;
  }>) {}

  async listArtifacts(input: Readonly<{ context: VerifiedRequestSecurityContext;
    cursor?: string; limit?: number }>): Promise<ArtifactPage> {
    const owner = authority(input.context);
    const cursor = input.cursor === undefined ? null : this.#openCursor(input.cursor, "artifact", owner);
    const limit = boundedLimit(input.limit);
    const rows = await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "listArtifacts" }, (transaction) => this.dependencies.repository.listArtifacts(transaction, {
      createdBefore: cursor?.createdAt ?? null, artifactRefBefore: cursor?.ref ?? null, limit: limit + 1,
    }));
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Object.freeze({ items: page.map(artifactSummary),
      pageInfo: Object.freeze({ hasMore, nextCursor: hasMore && last !== undefined
        ? this.#sealCursor("artifact", instant(last.createdAt), last.artifactRef, owner) : null }) });
  }

  async getArtifact(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    artifactRef: string;
  }>): Promise<ArtifactResponse> {
    const artifact = await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "getArtifact" }, (transaction) =>
      this.dependencies.repository.getArtifact(transaction, input.artifactRef));
    if (artifact === null) throw new Error("ARTIFACT_NOT_AVAILABLE");
    return Object.freeze({ artifact: artifactSummary(artifact) });
  }

  async listArtifactVersions(input: Readonly<{ context: VerifiedRequestSecurityContext;
    artifactRef: string; cursor?: string; limit?: number }>): Promise<ArtifactVersionPage> {
    const owner = authority(input.context);
    const cursor = input.cursor === undefined ? null :
      this.#openCursor(input.cursor, "version", owner, input.artifactRef);
    const limit = boundedLimit(input.limit);
    const rows = await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "listArtifactVersions" }, (transaction) => this.dependencies.repository.listVersions(transaction, {
      artifactRef: input.artifactRef, createdBefore: cursor?.createdAt ?? null,
      artifactVersionRefBefore: cursor?.ref ?? null, limit: limit + 1,
    }));
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return Object.freeze({ items: page.map(artifactVersion),
      pageInfo: Object.freeze({ hasMore, nextCursor: hasMore && last !== undefined
        ? this.#sealCursor("version", instant(last.createdAt), last.artifactVersionRef, owner,
          input.artifactRef) : null }) });
  }

  async getArtifactVersion(input: Readonly<{ context: VerifiedRequestSecurityContext;
    artifactRef: string; artifactVersionRef: string }>): Promise<ArtifactVersionResponse> {
    const version = await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "getArtifactVersion" }, (transaction) =>
      this.dependencies.repository.getVersion(transaction, input.artifactRef, input.artifactVersionRef));
    if (version === null) throw new Error("ARTIFACT_NOT_AVAILABLE");
    return Object.freeze({ version: artifactVersion(version) });
  }

  async issueDeliveryAuthorization(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    artifactRef: string;
    artifactVersionRef: string;
    request: ArtifactDeliveryAuthorizationInput;
  }>): Promise<ArtifactDeliveryAuthorizationResponse> {
    const owner = authority(input.context);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + MAXIMUM_TTL_MS).toISOString();
    const capability = this.dependencies.deliveryCapabilities.issue();
    const authorizationRef = `artifact-delivery-authorization:${this.#reference()}`;
    await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "issueArtifactDeliveryAuthorization" }, (transaction) =>
      this.dependencies.repository.createAuthorization(transaction, Object.freeze({
        authorizationRef, capabilityDigest: capability.capabilityDigest,
        ownerScope: Object.freeze({ siteRef: owner.siteRef, subjectRef: owner.subjectRef,
          subjectGeneration: owner.subjectGeneration, projectRef: owner.projectRef }),
        artifactRef: input.artifactRef, artifactVersionRef: input.artifactVersionRef,
        purpose: input.request.purpose, audience: "site-bff.artifact-delivery" as const,
        ...(input.request.purpose === "download" && input.request.suggestedFileName !== undefined
          ? { suggestedFileName: safeSuggestedFileName(input.request.suggestedFileName) } : {}),
        workload: Object.freeze({ siteRef: owner.siteRef, siteReleaseRef: owner.siteReleaseRef,
          workloadIdentityRef: owner.workloadIdentityRef, workloadBindingEpoch: owner.workloadBindingEpoch,
          siteSecurityEpoch: owner.siteSecurityEpoch }),
        issuedAt: now.toISOString(), expiresAt, revocationEpoch: 1n,
      })));
    return Object.freeze({ authorization: Object.freeze({ authorizationRef,
      artifactRef: input.artifactRef, artifactVersionRef: input.artifactVersionRef,
      purpose: input.request.purpose, audience: "site-bff.artifact-delivery" as const,
      deliveryCapability: capability.deliveryCapability, issuedAt: now.toISOString(), expiresAt }) });
  }

  async revokeDeliveryAuthorization(input: Readonly<{ context: VerifiedRequestSecurityContext;
    authorizationRef: string; reason?: string | undefined }>): Promise<ArtifactDeliveryRevocationResponse> {
    const reason = input.reason === undefined ? undefined : safeRevocationReason(input.reason);
    const revoked = await this.dependencies.unitOfWork.execute({ context: input.context,
      operation: "revokeArtifactDeliveryAuthorization" }, (transaction) =>
      this.dependencies.repository.revokeAuthorization(transaction, {
        authorizationRef: input.authorizationRef, revokedAt: this.#now().toISOString(),
        ...(reason === undefined ? {} : { reason }),
      }));
    if (revoked === null) throw new Error("ARTIFACT_NOT_AVAILABLE");
    return Object.freeze({ receipt: Object.freeze({ authorizationRef: input.authorizationRef,
      state: revoked.state, revokedAt: revoked.revokedAt }) });
  }

  #sealCursor(kind: "artifact" | "version", createdAt: string, ref: string,
    owner: OwnerAuthority, parentRef?: string): string {
    return this.dependencies.cursors.encode({ kind, created_at: createdAt, ref,
      site_ref: owner.siteRef, subject_ref: owner.subjectRef,
      subject_generation: owner.subjectGeneration.toString(), project_ref: owner.projectRef,
      ...(parentRef === undefined ? {} : { parent_ref: parentRef }) });
  }

  #openCursor(value: string, kind: "artifact" | "version", owner: OwnerAuthority,
    parentRef?: string):
  Readonly<{ createdAt: string; ref: string }> {
    const raw = this.dependencies.cursors.decode(value);
    const expectedKeys = parentRef === undefined
      ? "created_at,kind,project_ref,ref,site_ref,subject_generation,subject_ref"
      : "created_at,kind,parent_ref,project_ref,ref,site_ref,subject_generation,subject_ref";
    if (Object.keys(raw).sort().join(",") !== expectedKeys ||
        raw.kind !== kind || raw.site_ref !== owner.siteRef || raw.subject_ref !== owner.subjectRef ||
        raw.subject_generation !== owner.subjectGeneration.toString() || raw.project_ref !== owner.projectRef ||
        raw.parent_ref !== parentRef ||
        typeof raw.ref !== "string") throw new Error("PAGE_CURSOR_INVALID");
    return Object.freeze({ createdAt: instant(raw.created_at), ref: raw.ref });
  }
  #now(): Date {
    const value = (this.dependencies.clock ?? (() => new Date()))();
    if (!Number.isFinite(value.getTime())) throw new Error("ARTIFACT_DELIVERY_CLOCK_INVALID");
    return value;
  }
  #reference(): string { return (this.dependencies.reference ?? randomUUID)(); }
}

type OwnerAuthority = Readonly<{ siteRef: string; subjectRef: string; subjectGeneration: bigint;
  projectRef: string; siteReleaseRef: string; workloadIdentityRef: string;
  workloadBindingEpoch: bigint; siteSecurityEpoch: bigint }>;

function authority(context: VerifiedRequestSecurityContext): OwnerAuthority {
  if (context.actor.kind !== "user" || context.target.siteId === null || context.target.projectId === null ||
      context.trustedCaller.siteReleaseRef === undefined || context.trustedCaller.siteSecurityEpoch === undefined) {
    throw new Error("ARTIFACT_DELIVERY_NOT_ALLOWED");
  }
  return Object.freeze({ siteRef: context.target.siteId, subjectRef: context.actor.subjectId,
    subjectGeneration: positive(context.actor.subjectGeneration), projectRef: context.target.projectId,
    siteReleaseRef: context.trustedCaller.siteReleaseRef,
    workloadIdentityRef: context.trustedCaller.workloadIdentityId,
    workloadBindingEpoch: positive(context.trustedCaller.bindingEpoch),
    siteSecurityEpoch: positive(context.trustedCaller.siteSecurityEpoch) });
}

function artifactSummary(row: ArtifactSummaryRecord): ArtifactSummary {
  if (!["processing", "ready", "restricted", "unavailable", "deleted"].includes(row.availability)) {
    throw new Error("ARTIFACT_QUERY_RECORD_INVALID");
  }
  return Object.freeze({ artifactRef: row.artifactRef,
    currentArtifactVersionRef: row.currentArtifactVersionRef, mediaClass: "image" as const,
    availability: row.availability as ArtifactSummary["availability"], title: row.title,
    createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) });
}

function artifactVersion(row: ArtifactVersionRecord): ArtifactVersion {
  const common = { artifactRef: row.artifactRef, artifactVersionRef: row.artifactVersionRef,
    mediaClass: "image" as const, ownerVersion: positive(row.ownerVersion).toString(),
    versionNumber: positive(row.versionNumber).toString(),
    sourceArtifactVersionRefs: stringArray(row.sourceArtifactVersionRefs), createdAt: instant(row.createdAt) };
  if (row.availability === "ready") {
    if (row.byteSize === null || row.mediaType === null || row.width === null || row.height === null ||
        !Number.isInteger(row.width) || !Number.isInteger(row.height) || row.width < 1 || row.height < 1) {
      throw new Error("ARTIFACT_VERSION_QUERY_RECORD_INVALID");
    }
    const format = row.mediaType === "image/png" ? "png" : row.mediaType === "image/jpeg" ? "jpeg" :
      row.mediaType === "image/webp" ? "webp" : null;
    if (format === null) throw new Error("ARTIFACT_VERSION_QUERY_RECORD_INVALID");
    return Object.freeze({ ...common, availability: "ready" as const,
      display: Object.freeze({ byteSize: positive(row.byteSize).toString(), format,
        width: row.width, height: row.height }) });
  }
  if (row.availability === "restricted" || row.availability === "unavailable") {
    return Object.freeze({ ...common, availability: row.availability,
      safeFailure: Object.freeze({ code: row.availability === "restricted"
        ? "artifact_restricted" as const : "artifact_unavailable" as const,
      retryClass: "never" as const, safeMessage: row.availability === "restricted"
        ? "The artifact is restricted." : "The artifact is unavailable." }) });
  }
  if (row.availability !== "processing" && row.availability !== "deleted") {
    throw new Error("ARTIFACT_VERSION_QUERY_RECORD_INVALID");
  }
  return Object.freeze({ ...common, availability: row.availability });
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_REQUEST");
  return limit;
}
function positive(value: unknown): bigint {
  const result = typeof value === "bigint" ? value : typeof value === "string" && /^[0-9]+$/u.test(value)
    ? BigInt(value) : 0n;
  if (result < 1n || result > 18_446_744_073_709_551_615n) throw new Error("ARTIFACT_QUERY_RECORD_INVALID");
  return result;
}
function instant(value: unknown): string {
  const result = value instanceof Date ? value : typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error("ARTIFACT_QUERY_RECORD_INVALID");
  return result.toISOString();
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("ARTIFACT_VERSION_QUERY_RECORD_INVALID");
  }
  return [...value] as string[];
}

function safeSuggestedFileName(value: string): string {
  if (value.length < 1 || value.length > 255 || value.includes("/") || value.includes("\\") ||
      hasControlCharacter(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value.normalize("NFC");
}

function safeRevocationReason(value: string): string | undefined {
  if (value.length > 256 || hasControlCharacter(value)) throw new Error("INVALID_REQUEST");
  const normalized = value.normalize("NFC").trim();
  return normalized.length === 0 ? undefined : normalized;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}
