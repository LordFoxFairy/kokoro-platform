import { createHash, randomBytes } from "node:crypto";
import type {
  MediaArtifactCleanupRepository,
  MediaArtifactCleanupTask,
} from "../../application/media-artifact-cleanup-worker.js";
import type { MediaArtifactCleanupTaskRow } from "./media-image-worker-database.js";

export interface MediaArtifactCleanupDatabase {
  claimArtifactCleanup(input: Readonly<{ workerId: string; leaseTokenHash: string; leaseSeconds: number }> ):
    Promise<readonly MediaArtifactCleanupTaskRow[]>;
  renewArtifactCleanup(input: Readonly<{
    artifactVersionRef: string; leaseEpoch: bigint; leaseTokenHash: string; leaseSeconds: number;
  }>): Promise<void>;
  completeArtifactCleanup(input: Readonly<{
    artifactVersionRef: string; leaseEpoch: bigint; leaseTokenHash: string;
  }>): Promise<void>;
  retryArtifactCleanup(input: Readonly<{ artifactVersionRef: string; leaseEpoch: bigint;
    leaseTokenHash: string; errorCode: string; retryAt: string; failedAt: string }> ):
    Promise<"retry" | "dead_letter">;
  releaseArtifactCleanupLeases(input: Readonly<{ workerId: string; reason: string }>): Promise<void>;
}

export class PostgresMediaArtifactCleanupRepository implements MediaArtifactCleanupRepository {
  readonly #database: MediaArtifactCleanupDatabase;
  readonly #leaseToken: () => string;

  constructor(input: Readonly<{ database: MediaArtifactCleanupDatabase; leaseToken?: () => string }>) {
    this.#database = input.database;
    this.#leaseToken = input.leaseToken ?? (() => randomBytes(32).toString("base64url"));
  }

  async claim(input: Parameters<MediaArtifactCleanupRepository["claim"]>[0]): Promise<MediaArtifactCleanupTask | null> {
    const leaseToken = this.#leaseToken();
    const rows = await this.#database.claimArtifactCleanup({ workerId: input.workerId,
      leaseTokenHash: digest(leaseToken), leaseSeconds: leaseSeconds(input.leaseMs) });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_CLEANUP_CLAIM_AMBIGUOUS");
    const row = rows[0]!;
    return Object.freeze({ artifactVersionRef: row.artifactVersionRef, artifactRef: row.artifactRef,
      stagedObjectRef: row.stagedObjectRef, leaseEpoch: BigInt(row.leaseEpoch), leaseToken,
      ownerScope: Object.freeze({ siteRef: row.siteRef, subjectRef: row.subjectRef,
        subjectGeneration: BigInt(row.subjectGeneration), projectRef: row.projectRef }) });
  }

  renewLease(task: MediaArtifactCleanupTask, leaseMs: number): Promise<void> {
    return this.#database.renewArtifactCleanup({ ...fence(task), leaseSeconds: leaseSeconds(leaseMs) });
  }
  complete(task: MediaArtifactCleanupTask): Promise<void> {
    return this.#database.completeArtifactCleanup(fence(task));
  }
  retryOrDeadLetter(task: MediaArtifactCleanupTask,
    input: Parameters<MediaArtifactCleanupRepository["retryOrDeadLetter"]>[1]) {
    return this.#database.retryArtifactCleanup({ ...fence(task), ...input });
  }
  releaseOwnedLeases(input: Parameters<MediaArtifactCleanupRepository["releaseOwnedLeases"]>[0]): Promise<void> {
    return this.#database.releaseArtifactCleanupLeases(input);
  }
}

function fence(task: MediaArtifactCleanupTask) {
  return Object.freeze({ artifactVersionRef: task.artifactVersionRef, leaseEpoch: task.leaseEpoch,
    leaseTokenHash: digest(task.leaseToken) });
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function leaseSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000 || value % 1_000 !== 0) {
    throw new Error("MEDIA_CLEANUP_LEASE_INVALID");
  }
  return value / 1_000;
}
