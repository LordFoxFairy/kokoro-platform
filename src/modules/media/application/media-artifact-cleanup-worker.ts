import { SingleFlightLeaseHeartbeat } from "../../../shared/outbox-inbox/lease-heartbeat.js";
import type { ArtifactOwnerScope } from "../../artifact/index.js";

export type MediaArtifactCleanupTask = Readonly<{
  artifactVersionRef: string;
  artifactRef: string;
  stagedObjectRef: string;
  ownerScope: ArtifactOwnerScope;
  leaseEpoch: bigint;
  leaseToken: string;
}>;

export interface MediaArtifactCleanupRepository {
  claim(input: Readonly<{ workerId: string; leaseMs: number }>): Promise<MediaArtifactCleanupTask | null>;
  renewLease(task: MediaArtifactCleanupTask, leaseMs: number): Promise<void>;
  complete(task: MediaArtifactCleanupTask): Promise<void>;
  retryOrDeadLetter(task: MediaArtifactCleanupTask, input: Readonly<{
    errorCode: string; retryAt: string; failedAt: string;
  }>): Promise<"retry" | "dead_letter">;
  releaseOwnedLeases(input: Readonly<{
    workerId: string; reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed";
  }>): Promise<void>;
}

export interface MediaArtifactStagedCleanupPort {
  cleanupStaged(input: Readonly<{
    artifactRef: string;
    artifactVersionRef: string;
    stagedObjectRef: string;
    ownerScope: ArtifactOwnerScope;
  }>, signal: AbortSignal): Promise<void>;
}

export class MediaArtifactCleanupWorker {
  readonly #dependencies: Readonly<{
    repository: MediaArtifactCleanupRepository;
    cleanup: MediaArtifactStagedCleanupPort;
    workerId: string;
    clock: () => Date;
    leaseMs: number;
    heartbeatMs: number;
    renewalTimeoutMs: number;
  }>;
  #claiming = true;
  #cycle: Promise<"idle" | "completed" | "reconciling" | "dead_letter"> | undefined;

  constructor(input: Readonly<{
    repository: MediaArtifactCleanupRepository;
    cleanup: MediaArtifactStagedCleanupPort;
    workerId: string;
    clock?: () => Date;
    leaseMs?: number;
    leaseHeartbeatMs?: number;
    leaseRenewalTimeoutMs?: number;
  }>) {
    reference(input.workerId);
    const leaseMs = bounded(input.leaseMs ?? 30_000, 100, 300_000, "MEDIA_CLEANUP_LEASE_INVALID");
    const heartbeatMs = bounded(input.leaseHeartbeatMs ?? Math.floor(leaseMs / 3), 1, 100_000,
      "MEDIA_CLEANUP_HEARTBEAT_INVALID");
    const renewalTimeoutMs = bounded(input.leaseRenewalTimeoutMs ?? Math.min(heartbeatMs, 5_000), 1, 100_000,
      "MEDIA_CLEANUP_RENEWAL_TIMEOUT_INVALID");
    this.#dependencies = Object.freeze({ ...input, clock: input.clock ?? (() => new Date()),
      leaseMs, heartbeatMs, renewalTimeoutMs });
  }

  runOneCycle(context: Readonly<{ signal: AbortSignal }> | AbortSignal) {
    const signal = context instanceof AbortSignal ? context : context.signal;
    if (this.#cycle !== undefined) return this.#cycle;
    const cycle = this.#run(signal).finally(() => { if (this.#cycle === cycle) this.#cycle = undefined; });
    this.#cycle = cycle;
    return cycle;
  }

  stopClaiming(): Promise<void> { this.#claiming = false; return Promise.resolve(); }
  returnLeases(reason: "shutdown" | "shutdown-deadline" | "stop-claim-failed"): Promise<void> {
    return this.#dependencies.repository.releaseOwnedLeases({ workerId: this.#dependencies.workerId, reason });
  }

  async #run(signal: AbortSignal): Promise<"idle" | "completed" | "reconciling" | "dead_letter"> {
    if (!this.#claiming) return "idle";
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const task = await this.#dependencies.repository.claim({ workerId: this.#dependencies.workerId,
      leaseMs: this.#dependencies.leaseMs });
    if (task === null) return "idle";
    validateTask(task);
    const heartbeat = new SingleFlightLeaseHeartbeat(
      () => this.#dependencies.repository.renewLease(task, this.#dependencies.leaseMs),
      { intervalMs: this.#dependencies.heartbeatMs, renewalTimeoutMs: this.#dependencies.renewalTimeoutMs,
        timeoutCode: "MEDIA_CLEANUP_LEASE_RENEWAL_TIMEOUT" },
    );
    heartbeat.start();
    try {
      await heartbeat.assertOwned();
      await this.#dependencies.cleanup.cleanupStaged({ artifactRef: task.artifactRef,
        artifactVersionRef: task.artifactVersionRef, stagedObjectRef: task.stagedObjectRef,
        ownerScope: task.ownerScope },
      AbortSignal.any([signal, heartbeat.signal]));
      await this.#dependencies.repository.complete(task);
      return "completed";
    } catch (error) {
      if (signal.aborted || heartbeat.lost) throw error;
      const now = this.#date();
      const resolution = await this.#dependencies.repository.retryOrDeadLetter(task, {
        errorCode: code(error), retryAt: new Date(now.getTime() + 1_000).toISOString(),
        failedAt: now.toISOString(),
      });
      return resolution === "retry" ? "reconciling" : "dead_letter";
    } finally {
      await heartbeat.stop();
    }
  }

  #date(): Date {
    const value = this.#dependencies.clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_CLEANUP_CLOCK_INVALID");
    return value;
  }
}

function validateTask(value: MediaArtifactCleanupTask): void {
  reference(value.artifactVersionRef); reference(value.artifactRef); reference(value.stagedObjectRef);
  if (value.leaseEpoch < 1n || value.leaseToken.length < 16) throw new Error("MEDIA_CLEANUP_TASK_INVALID");
}
function reference(value: string): void {
  if (value.length < 1 || value.length > 512 || value.trim() !== value) throw new Error("MEDIA_REFERENCE_INVALID");
}
function bounded(value: number, minimum: number, maximum: number, errorCode: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(errorCode); return value;
}
function code(value: unknown): string {
  return value instanceof Error && /^[A-Z][A-Z0-9_.:-]{2,127}$/u.test(value.message)
    ? value.message : "MEDIA_CLEANUP_UNEXPECTED";
}
