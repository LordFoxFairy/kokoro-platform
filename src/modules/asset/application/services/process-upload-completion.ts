import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { digestAssetCommand } from "../asset-digest.js";
import type {
  AssetCompletionWorkerRepositoryPort,
  AssetQuarantineObjectStorePort,
  AssetWorkerUnitOfWorkPort,
} from "../contracts/asset-completion-worker-ports.js";
import { evaluateQuarantineObservation } from "../../domain/blob-candidate.js";

export type ProcessUploadCompletionResult =
  | Readonly<{ disposition: "accepted"; candidateRef: string }>
  | Readonly<{ disposition: "rejected"; code: string }>
  | Readonly<{ disposition: "retry"; code: string }>
  | Readonly<{ disposition: "superseded" }>;

export class ProcessUploadCompletionService {
  constructor(private readonly dependencies: Readonly<{
    deployment: Readonly<{ environment: string; region: string }>;
    unitOfWork: AssetWorkerUnitOfWorkPort;
    repository: AssetCompletionWorkerRepositoryPort;
    objectStore: AssetQuarantineObjectStorePort;
    reference?: () => string;
  }>) {}

  async execute(input: Readonly<{
    eventId: string;
    siteRef: string;
    intentRef: string;
    sessionRef: string;
    expectedVersion: bigint;
    correlationId: string;
  }>): Promise<ProcessUploadCompletionResult> {
    bounded(input.eventId, "ASSET_COMPLETION_EVENT_ID_INVALID");
    bounded(input.siteRef, "ASSET_SITE_REF_INVALID");
    bounded(input.intentRef, "ASSET_UPLOAD_INTENT_REF_INVALID");
    bounded(input.sessionRef, "ASSET_UPLOAD_SESSION_REF_INVALID");
    if (input.expectedVersion < 1n) throw new Error("ASSET_UPLOAD_VERSION_INVALID");
    const work = await this.dependencies.unitOfWork.execute(
      { operation: "asset.upload-completion.observe", siteRef: input.siteRef },
      (transaction) => this.dependencies.repository.loadCompletionWork(transaction, input),
    );
    if (work.disposition !== "work") return Object.freeze({ disposition: "superseded" });
    let observation = await this.dependencies.objectStore.observe({
      storageTenantRef: work.session.storageTenantRef,
      storageRegion: work.session.storageRegion,
      quarantineObjectRef: work.session.quarantineObjectRef,
    });
    const candidateRef = this.reference();
    let decision = evaluateQuarantineObservation({
      candidateRef, intent: work.intent, session: work.session, observation,
    });
    if (decision.disposition === "retry") return decision;
    if (decision.disposition === "checksum_required") {
      if (observation.disposition !== "present") throw new Error("ASSET_OBSERVATION_INVARIANT");
      const checksumSha256 = await this.dependencies.objectStore.computeSha256({
        storageTenantRef: work.session.storageTenantRef,
        storageRegion: work.session.storageRegion,
        quarantineObjectRef: work.session.quarantineObjectRef,
        providerVersionRef: observation.providerVersionRef,
        maximumBytes: decision.maximumBytes,
      });
      observation = Object.freeze({ ...observation, checksumSha256 });
      decision = evaluateQuarantineObservation({
        candidateRef, intent: work.intent, session: work.session, observation,
      });
    }
    if (decision.disposition === "checksum_required" || decision.disposition === "retry") {
      throw new Error("ASSET_OBSERVATION_INVARIANT");
    }
    if (decision.disposition === "rejected") {
      if (observation.disposition !== "present") throw new Error("ASSET_OBSERVATION_INVARIANT");
      const cleanupGroupRef = this.reference();
      const cleanupRef = this.reference();
      const cleanupEvent = eventEnvelope(input, "asset.object.cleanup.requested", json({
        kind: "asset_object_cleanup_requested_v1", siteRef: input.siteRef,
        ...this.dependencies.deployment,
        cleanupRef, expectedVersion: "1",
      }), this.reference(), cleanupRef);
      const result = await this.dependencies.unitOfWork.execute(
        { operation: "asset.upload-completion.observe", siteRef: input.siteRef },
        (transaction) => this.dependencies.repository.rejectCompletion(transaction, {
          siteRef: input.siteRef, intentRef: input.intentRef, sessionRef: input.sessionRef,
          expectedSessionVersion: work.session.expectedVersion, reasonCode: decision.code,
          rejectionRef: this.reference(),
          cleanupPlan: Object.freeze({ cleanupGroupRef, terminalReservationState: "released",
            targets: Object.freeze([Object.freeze({ cleanupRef, objectRole: "quarantine",
              storageTenantRef: work.session.storageTenantRef,
              storageRegion: work.session.storageRegion,
              objectRef: work.session.quarantineObjectRef,
              providerVersionRef: observation.providerVersionRef,
              retainedBytes: observation.size,
              cleanupEvent,
            })]),
          }),
        }),
      );
      return result === "superseded"
        ? Object.freeze({ disposition: "superseded" })
        : Object.freeze({ disposition: "rejected", code: decision.code });
    }
    const scanEvent = eventEnvelope(input, "asset.scan.requested", json({
      kind: "asset_scan_requested_v1", siteRef: input.siteRef,
      ...this.dependencies.deployment,
      candidateRef: decision.candidate.candidateRef,
      expectedVersion: decision.candidate.expectedVersion.toString(),
    }), this.reference(), decision.candidate.candidateRef);
    const result = await this.dependencies.unitOfWork.execute(
      { operation: "asset.upload-completion.observe", siteRef: input.siteRef },
      (transaction) => this.dependencies.repository.commitCandidate(transaction, {
        candidate: decision.candidate,
        expectedSessionVersion: work.session.expectedVersion,
        scanEvent,
      }),
    );
    return result === "superseded"
      ? Object.freeze({ disposition: "superseded" })
      : Object.freeze({ disposition: "accepted", candidateRef: decision.candidate.candidateRef });
  }

  private reference(): string {
    return (this.dependencies.reference ?? randomUUID)();
  }
}

function eventEnvelope(
  input: Readonly<{ eventId: string; sessionRef: string; correlationId: string }>,
  eventType: string,
  payload: JsonValue,
  eventId: string,
  aggregateId: string,
) {
  return Object.freeze({
    eventId, owner: "asset", eventType, aggregateId,
    payload, payloadDigest: digestAssetCommand(payload), correlationId: input.correlationId,
    causationId: input.eventId,
  });
}

function json(value: Readonly<Record<string, string>>): JsonValue {
  return Object.freeze({ ...value });
}

function bounded(value: string, code: string): void {
  if (value.length < 3 || value.length > 128) throw new Error(code);
}
