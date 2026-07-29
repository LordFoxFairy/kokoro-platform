import { createHash } from "node:crypto";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { Backend, Permissions, SkillGrant, McpGrant } from "@kokoro/platform-kit";
import {
  AdmissionRetryClass,
  SafeAdmissionSnapshotSchema,
  SafeCapabilityKind,
  type AdmissionDenialSchema,
  type AdmissionPendingSchema,
  type PrepareRunEffect,
} from "../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import {
  requireDispatchOwnerEvidence,
  type DispatchOwnerEvidence,
  type DispatchOwnerEvidenceLookup,
} from "./dispatch-owner-evidence.js";
import type { VerifiedGaRunRequestOwnerFacts } from "./ga-run-request-draft-factory.js";
import type {
  AdmissionAuthorityCommand,
  AdmissionOwnerAuthority,
  FinalizeRunOwnerDecision,
  PrepareRunOwnerDecision,
  ReconcileRunOwnerDecision,
  ReleaseRunOwnerDecision,
} from "./admission-ports.js";

const MAX_AUTHORIZATION_TTL_MS = 5 * 60 * 1_000;

type Denied = Readonly<{
  kind: "denied";
  denial: MessageInitShape<typeof AdmissionDenialSchema>;
}>;
type Pending = Readonly<{
  kind: "pending";
  pending: MessageInitShape<typeof AdmissionPendingSchema>;
}>;
export type AdmissionOwnerResolution<Value> =
  | Readonly<{ kind: "resolved"; value: Value }>
  | Denied
  | Pending;

export interface AdmissionOwnerUnitOfWork {
  execute<Result>(
    command: AdmissionAuthorityCommand,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface AdmissionSessionOwnerPort {
  resolve(
    input: Readonly<{
      siteId: string;
      projectRef: string;
      sessionId: string;
      launchId: string;
      runId: string;
      triggerMessageId: string;
      commandId: string;
      requestDigest: string;
    }>,
    signal: AbortSignal,
  ): Promise<AdmissionOwnerResolution<Readonly<{ threadId: string }>>>;
  verifyFinalizeReceipts(
    input: Readonly<{
      siteId: string;
      sessionId: string;
      launchId: string;
      manifestRef: string;
      authorizationSegmentRef: string;
      expectedSegmentVersion: bigint;
      sessionIntentReceiptRef: string;
      commandId: string;
      requestDigest: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ kind: "verified" }> | Denied | Pending>;
}

export interface AdmissionExecutionBindingOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      sessionId: string;
      threadId: string;
      capabilitySnapshotRef: string;
      configurationRevisionId: string;
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    namespace: string;
    sessionExecutionBindingRef: string;
  }>>>;
}

export interface AdmissionSessionGrantOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      sessionId: string;
      runId: string;
      configurationRevisionId: string;
      credential: string;
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    subjectRef: string;
    subjectGeneration: bigint;
  }>>>;
}

export interface AdmissionSiteOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; projectRef: string; locale: string }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    configurationRevisionId: string;
    policyDecisionRef: string;
  }>>>;
}

export interface AdmissionRuntimePolicyOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      configurationRevisionId: string;
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    backend: Backend;
    permissions: Permissions;
  }>>>;
}

export interface AdmissionModelOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      configurationRevisionId: string;
      modelOptionRevisionRef: string;
      requestedEffort?: string | undefined;
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    provider: string;
    name: string;
    effort?: string | undefined;
    thinking?: boolean | undefined;
    modelLabel: string;
  }>>>;
}

export interface AdmissionCapabilityOwnerPort {
  resolve(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      configurationRevisionId: string;
      requestedAgentOptionRef?: string | undefined;
      requestedSkillOptionRefs: readonly string[];
      requestedMcpOptionRefs: readonly string[];
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    capabilitySnapshotRef: string;
    agent?: string | undefined;
    agentLabel?: string | undefined;
    tools: readonly string[];
    skills: readonly SkillGrant[];
    mcpServers: readonly McpGrant[];
    subagents: readonly string[];
    safeCapabilities: readonly Readonly<{ kind: "skill" | "mcp"; label: string }>[];
    prerequisiteRefs: readonly string[];
  }>>>;
}

export interface AdmissionAssetOwnerPort {
  validate(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      sessionId: string;
      subjectRef: string;
      subjectGeneration: bigint;
      attachments: readonly Readonly<{
        assetRef: string;
        assetVersionRef: string;
        assetGrantRef: string;
      }>[];
    }>,
  ): Promise<AdmissionOwnerResolution<undefined>>;
}

export interface AdmissionBudgetOwnerPort {
  reserveRoot(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      projectRef: string;
      launchId: string;
      runId: string;
      modelOptionRevisionRef: string;
      commandId: string;
      manifestRef: string;
      manifestDigest: string;
      maximumExpiresAt: string;
      configurationRevisionId: string;
      subjectRef: string;
      subjectGeneration: bigint;
      requestDigest: string;
      agentRef?: string | undefined;
    }>,
  ): Promise<AdmissionOwnerResolution<Readonly<{
    executionBudgetRootRef: string;
    rootHoldRef: string;
    authorizationSegmentRef: string;
    segmentVersion: bigint;
    expiresAt: string;
    estimatedCostDisplay?: string | undefined;
  }>>>;
  commitRoot(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string; rootHoldRef: string; authorizationSegmentRef: string;
      manifestRef: string; expectedSegmentVersion: bigint; commandId: string; requestDigest: string;
    }>,
  ): Promise<void>;
  releaseRoot(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string; rootHoldRef: string; authorizationSegmentRef: string; reasonCode: string;
      manifestRef: string; expectedSegmentVersion: bigint; commandId: string; requestDigest: string;
      noDispatchEvidenceRef: string;
    }>,
  ): Promise<void>;
  reconcileRoot(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      rootHoldRef: string;
      authorizationSegmentRef: string;
      manifestRef: string;
      expectedSegmentVersion: bigint;
      commandId: string;
      requestDigest: string;
      terminalEvidenceRef?: string | undefined;
    }>,
  ): Promise<"settled" | "reconciliation_required">;
}

export type AdmissionAuthorizationState =
  | "reserved"
  | "committed"
  | "released"
  | "expired"
  | "reconciliation_required"
  | "settled";

export interface AdmissionAuthorizationRecord {
  readonly siteId: string;
  readonly manifestRef: string;
  readonly manifestDigest: string;
  readonly sessionId: string;
  readonly launchId: string;
  readonly runId: string;
  readonly rootHoldRef: string;
  readonly authorizationSegmentRef: string;
  readonly segmentVersion: bigint;
  readonly state: AdmissionAuthorizationState;
  readonly expiresAt: string;
}

export interface AdmissionLifecycleOwnerPort {
  prepare(
    transaction: PlatformTransaction,
    input: Readonly<{
      siteId: string;
      commandId: string;
      requestDigest: string;
      manifestRef: string;
      manifestDigest: string;
      maximumExpiresAt: string;
      sessionExecutionBindingRef: string;
      capabilitySnapshotRef: string;
      configurationRevisionId: string;
      executionBudgetRootRef: string;
      rootHoldRef: string;
      authorizationSegmentRef: string;
      segmentVersion: bigint;
      expiresAt: string;
      ownerFacts: VerifiedGaRunRequestOwnerFacts;
      effect: PrepareRunEffect;
    }>,
  ): Promise<AdmissionAuthorizationRecord>;
  read(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; manifestRef: string; authorizationSegmentRef: string }>,
  ): Promise<AdmissionAuthorizationRecord | null>;
  lock(
    transaction: PlatformTransaction,
    input: Readonly<{ siteId: string; manifestRef: string; authorizationSegmentRef: string }>,
  ): Promise<AdmissionAuthorizationRecord | null>;
  commit(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord): Promise<AdmissionAuthorizationRecord>;
  expire(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord): Promise<AdmissionAuthorizationRecord>;
  release(
    transaction: PlatformTransaction,
    record: AdmissionAuthorizationRecord,
    evidence: DispatchOwnerEvidence,
  ): Promise<AdmissionAuthorizationRecord>;
  requireReconciliation(
    transaction: PlatformTransaction,
    record: AdmissionAuthorizationRecord,
  ): Promise<AdmissionAuthorizationRecord>;
  settle(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord): Promise<AdmissionAuthorizationRecord>;
}

export type AdmissionExecutionEvidence =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "execution_observed"; safeStatusRef?: string | undefined }>
  | Readonly<{ kind: "terminal_observed"; terminalEvidenceRef: string; safeStatusRef?: string | undefined }>;

export interface AdmissionExecutionEvidenceOwnerPort {
  resolve(
    input: Readonly<{
      siteId: string;
      sessionId: string;
      launchId: string;
      runId: string;
      gaDurableEventReceiptRef?: string | undefined;
      terminalOwnerEvidenceRef?: string | undefined;
    }>,
    signal: AbortSignal,
  ): Promise<AdmissionExecutionEvidence>;
}

export interface PlatformAdmissionOwnerPorts {
  readonly unitOfWork: AdmissionOwnerUnitOfWork;
  readonly session: AdmissionSessionOwnerPort;
  readonly sessionGrant: AdmissionSessionGrantOwnerPort;
  readonly executionBinding: AdmissionExecutionBindingOwnerPort;
  readonly site: AdmissionSiteOwnerPort;
  readonly runtimePolicy: AdmissionRuntimePolicyOwnerPort;
  readonly model: AdmissionModelOwnerPort;
  readonly capability: AdmissionCapabilityOwnerPort;
  readonly assets: AdmissionAssetOwnerPort;
  readonly budget: AdmissionBudgetOwnerPort;
  readonly lifecycle: AdmissionLifecycleOwnerPort;
  readonly dispatchEvidence: DispatchOwnerEvidenceLookup;
  readonly executionEvidence: AdmissionExecutionEvidenceOwnerPort;
}

export class PlatformAdmissionOwnerAuthority implements AdmissionOwnerAuthority {
  readonly #ports: PlatformAdmissionOwnerPorts;
  readonly #clock: () => Date;

  constructor(input: Readonly<{ ports: PlatformAdmissionOwnerPorts; clock?: () => Date }>) {
    assertPlatformAdmissionOwnerPorts(input.ports);
    this.#ports = input.ports;
    this.#clock = input.clock ?? (() => new Date());
  }

  async prepareRun(
    command: Parameters<AdmissionOwnerAuthority["prepareRun"]>[0],
  ): Promise<PrepareRunOwnerDecision> {
    const session = await this.#ports.session.resolve({
      siteId: command.siteId,
      projectRef: command.effect.projectRef,
      sessionId: command.effect.sessionId,
      launchId: command.effect.launchId,
      runId: command.effect.proposedRunId,
      triggerMessageId: command.effect.triggerMessageId,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
    }, AbortSignal.timeout(5_000));
    if (session.kind !== "resolved") return session;
    return this.#ports.unitOfWork.execute(command, async (transaction) => {
      const site = await this.#ports.site.resolve(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        locale: command.effect.clientIntent!.locale,
      });
      if (site.kind !== "resolved") return site;
      const sessionGrant = await this.#ports.sessionGrant.resolve(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        sessionId: command.effect.sessionId,
        runId: command.effect.proposedRunId,
        configurationRevisionId: site.value.configurationRevisionId,
        credential: command.effect.sessionAccessGrant,
      });
      if (sessionGrant.kind !== "resolved") return sessionGrant;
      const runtimePolicy = await this.#ports.runtimePolicy.resolve(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        configurationRevisionId: site.value.configurationRevisionId,
      });
      if (runtimePolicy.kind !== "resolved") return runtimePolicy;
      const model = await this.#ports.model.resolve(transaction, {
        siteId: command.siteId,
        configurationRevisionId: site.value.configurationRevisionId,
        modelOptionRevisionRef: command.effect.modelOptionRevisionRef,
        ...(command.effect.clientIntent!.effort === undefined
          ? {}
          : { requestedEffort: command.effect.clientIntent!.effort }),
      });
      if (model.kind !== "resolved") return model;
      const capability = await this.#ports.capability.resolve(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        configurationRevisionId: site.value.configurationRevisionId,
        ...(command.effect.initialIntent?.requestedAgentOptionRef === undefined
          ? {}
          : { requestedAgentOptionRef: command.effect.initialIntent.requestedAgentOptionRef }),
        requestedSkillOptionRefs: command.effect.initialIntent?.requestedSkillOptionRefs ?? [],
        requestedMcpOptionRefs: command.effect.initialIntent?.requestedMcpOptionRefs ?? [],
      });
      if (capability.kind !== "resolved") return capability;
      const assets = await this.#ports.assets.validate(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        sessionId: command.effect.sessionId,
        subjectRef: sessionGrant.value.subjectRef,
        subjectGeneration: sessionGrant.value.subjectGeneration,
        attachments: command.effect.attachmentRefs,
      });
      if (assets.kind !== "resolved") return assets;
      const executionBinding = await this.#ports.executionBinding.resolve(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        sessionId: command.effect.sessionId,
        threadId: session.value.threadId,
        capabilitySnapshotRef: capability.value.capabilitySnapshotRef,
        configurationRevisionId: site.value.configurationRevisionId,
      });
      if (executionBinding.kind !== "resolved") return executionBinding;
      const ownerFacts: VerifiedGaRunRequestOwnerFacts = {
        kind: "run.request",
        run_id: command.effect.proposedRunId,
        thread_id: session.value.threadId,
        input: {
          message_id: command.effect.triggerMessageId,
          content: command.effect.triggerMessageContent,
        },
        runtime: {
          agent_type: "general" as const,
          ...(capability.value.agent === undefined ? {} : { agent: capability.value.agent }),
          model: {
            provider: model.value.provider,
            name: model.value.name,
            ...(model.value.effort === undefined ? {} : { effort: model.value.effort }),
            ...(model.value.thinking === undefined ? {} : { thinking: model.value.thinking }),
          },
          tools: [...capability.value.tools],
          skills: [...capability.value.skills],
          mcp_servers: [...capability.value.mcpServers],
          subagents: [...capability.value.subagents],
          backend: runtimePolicy.value.backend,
          permissions: { ...runtimePolicy.value.permissions },
        },
        context: {
          namespace: executionBinding.value.namespace,
          session_id: command.effect.sessionId,
        },
      };
      const manifestDigest = digestManifest(command.siteId, command.effect, ownerFacts, {
        sessionExecutionBindingRef: executionBinding.value.sessionExecutionBindingRef,
        capabilitySnapshotRef: capability.value.capabilitySnapshotRef,
        configurationRevisionId: site.value.configurationRevisionId,
      });
      const manifestRef = `execution-manifest:sha256:${manifestDigest}`;
      const maximumExpiresAt = new Date(this.#now() + MAX_AUTHORIZATION_TTL_MS).toISOString();
      const budget = await this.#ports.budget.reserveRoot(transaction, {
        siteId: command.siteId,
        projectRef: command.effect.projectRef,
        launchId: command.effect.launchId,
        runId: command.effect.proposedRunId,
        modelOptionRevisionRef: command.effect.modelOptionRevisionRef,
        commandId: command.commandId,
        manifestRef,
        manifestDigest,
        maximumExpiresAt,
        configurationRevisionId: site.value.configurationRevisionId,
        subjectRef: sessionGrant.value.subjectRef,
        subjectGeneration: sessionGrant.value.subjectGeneration,
        requestDigest: command.requestDigest,
        ...(capability.value.agent === undefined ? {} : { agentRef: capability.value.agent }),
      });
      if (budget.kind !== "resolved") return budget;
      const record = await this.#ports.lifecycle.prepare(transaction, {
        siteId: command.siteId,
        commandId: command.commandId,
        requestDigest: command.requestDigest,
        manifestRef,
        manifestDigest,
        maximumExpiresAt,
        sessionExecutionBindingRef: executionBinding.value.sessionExecutionBindingRef,
        capabilitySnapshotRef: capability.value.capabilitySnapshotRef,
        configurationRevisionId: site.value.configurationRevisionId,
        executionBudgetRootRef: budget.value.executionBudgetRootRef,
        rootHoldRef: budget.value.rootHoldRef,
        authorizationSegmentRef: budget.value.authorizationSegmentRef,
        segmentVersion: budget.value.segmentVersion,
        expiresAt: budget.value.expiresAt,
        ownerFacts,
        effect: command.effect,
      });
      assertPreparedRecord(
        record,
        command,
        budget.value,
        manifestRef,
        manifestDigest,
        maximumExpiresAt,
        this.#now(),
      );
      const prepared = {
        manifestRef: record.manifestRef,
        manifestDigest: record.manifestDigest,
        sessionExecutionBindingRef: executionBinding.value.sessionExecutionBindingRef,
        capabilitySnapshotRef: capability.value.capabilitySnapshotRef,
        configurationRevisionId: site.value.configurationRevisionId,
        executionBudgetRootRef: budget.value.executionBudgetRootRef,
        rootHoldRef: budget.value.rootHoldRef,
        authorizationSegmentRef: record.authorizationSegmentRef,
        segmentVersion: record.segmentVersion,
        expiresAt: timestampFromDate(new Date(record.expiresAt)),
        safeAdmissionSnapshot: create(SafeAdmissionSnapshotSchema, {
          modelLabel: model.value.modelLabel,
          ...(capability.value.agentLabel === undefined ? {} : { agentLabel: capability.value.agentLabel }),
          ...(budget.value.estimatedCostDisplay === undefined
            ? {}
            : { estimatedCostDisplay: budget.value.estimatedCostDisplay }),
          policyDecisionRef: site.value.policyDecisionRef,
          capabilities: capability.value.safeCapabilities.map((item) => ({
            kind: item.kind === "skill" ? SafeCapabilityKind.SKILL : SafeCapabilityKind.MCP,
            label: item.label,
          })),
        }),
      };
      return capability.value.prerequisiteRefs.length === 0
        ? { kind: "accepted", ownerFacts, prepared, prerequisiteRefs: [] }
        : {
            kind: "waiting_prerequisite",
            ownerFacts,
            prepared,
            prerequisiteRefs: Object.freeze([...capability.value.prerequisiteRefs]),
          };
    });
  }

  async finalizeRunAuthorization(
    command: Parameters<AdmissionOwnerAuthority["finalizeRunAuthorization"]>[0],
  ): Promise<FinalizeRunOwnerDecision> {
    const observed = await this.#ports.unitOfWork.execute(command, (transaction) =>
      this.#ports.lifecycle.read(transaction, lifecycleLookup(command)));
    if (observed === null) return denied("ADMISSION_AUTHORIZATION_NOT_FOUND");
    assertLifecycleIdentity(observed, command.siteId, command.effect);
    const replay = replayFinalized(observed, command.effect.expectedSegmentVersion, this.#date());
    if (replay !== null) return replay;
    assertExpectedSegmentVersion(observed, command.effect.expectedSegmentVersion);
    if (observed.state !== "reserved") return denied("ADMISSION_AUTHORIZATION_NOT_FINALIZABLE");
    const verified = await this.#ports.session.verifyFinalizeReceipts({
      siteId: command.siteId,
      sessionId: observed.sessionId,
      launchId: observed.launchId,
      manifestRef: command.effect.manifestRef,
      authorizationSegmentRef: command.effect.authorizationSegmentRef,
      expectedSegmentVersion: command.effect.expectedSegmentVersion,
      sessionIntentReceiptRef: command.effect.sessionIntentReceiptRef,
      commandId: command.commandId,
      requestDigest: command.requestDigest,
    }, AbortSignal.timeout(5_000));
    if (verified.kind !== "verified") return verified;
    return this.#ports.unitOfWork.execute(command, async (transaction) => {
      const record = await this.#ports.lifecycle.lock(transaction, lifecycleLookup(command));
      if (record === null) return denied("ADMISSION_AUTHORIZATION_NOT_FOUND");
      assertLifecycleIdentity(record, command.siteId, command.effect);
      const racedReplay = replayFinalized(record, command.effect.expectedSegmentVersion, this.#date());
      if (racedReplay !== null) return racedReplay;
      assertSameAuthorization(record, observed);
      assertExpectedSegmentVersion(record, command.effect.expectedSegmentVersion);
      if (record.state !== "reserved") return denied("ADMISSION_AUTHORIZATION_NOT_FINALIZABLE");
      if (Date.parse(record.expiresAt) <= this.#now()) {
        await this.#ports.budget.releaseRoot(transaction, {
          siteId: command.siteId,
          rootHoldRef: record.rootHoldRef,
          authorizationSegmentRef: record.authorizationSegmentRef,
          reasonCode: "AUTHORIZATION_EXPIRED",
          manifestRef: record.manifestRef,
          expectedSegmentVersion: record.segmentVersion,
          commandId: command.commandId,
          requestDigest: command.requestDigest,
          noDispatchEvidenceRef: `admission-expiry:${record.manifestDigest}`,
        });
        await this.#ports.lifecycle.expire(transaction, record);
        return { kind: "expired", expired: { expiredAt: timestampFromDate(this.#date()) } };
      }
      await this.#ports.budget.commitRoot(transaction, {
        siteId: command.siteId,
        rootHoldRef: record.rootHoldRef,
        authorizationSegmentRef: record.authorizationSegmentRef,
        manifestRef: record.manifestRef,
        expectedSegmentVersion: record.segmentVersion,
        commandId: command.commandId,
        requestDigest: command.requestDigest,
      });
      const changed = await this.#ports.lifecycle.commit(transaction, record);
      assertTransition(changed, record, "committed");
      return committed(changed, this.#date());
    });
  }

  async releaseRunAuthorization(
    command: Parameters<AdmissionOwnerAuthority["releaseRunAuthorization"]>[0],
  ): Promise<ReleaseRunOwnerDecision> {
    const observed = await this.#ports.unitOfWork.execute(command, (transaction) =>
      this.#ports.lifecycle.read(transaction, lifecycleLookup(command)));
    if (observed === null) return notReleasable("ADMISSION_AUTHORIZATION_NOT_FOUND");
    assertLifecycleIdentity(observed, command.siteId, command.effect);
    if (
      observed.state === "released" &&
      observed.segmentVersion === command.effect.expectedSegmentVersion + 1n
    ) return alreadyReleased(observed, this.#date());
    assertExpectedSegmentVersion(observed, command.effect.expectedSegmentVersion);
    if (observed.state !== "reserved") return notReleasable("ADMISSION_AUTHORIZATION_ALREADY_EFFECTFUL");
    const evidence = requireDispatchOwnerEvidence(
      await this.#ports.dispatchEvidence.get({
        siteId: command.siteId,
        sessionId: observed.sessionId,
        evidenceRef: command.effect.noDispatchEvidenceRef,
      }, AbortSignal.timeout(5_000)),
      {
        kind: "no_dispatch",
        siteId: command.siteId,
        sessionId: observed.sessionId,
        evidenceRef: command.effect.noDispatchEvidenceRef,
        launchId: observed.launchId,
        runId: observed.runId,
        authorizationSegmentRef: observed.authorizationSegmentRef,
        authorizationSegmentVersion: observed.segmentVersion.toString(),
      },
    );
    return this.#ports.unitOfWork.execute(command, async (transaction) => {
      const locked = await this.#ports.lifecycle.lock(transaction, lifecycleLookup(command));
      if (locked === null) return notReleasable("ADMISSION_AUTHORIZATION_NOT_FOUND");
      assertSameAuthorization(locked, observed);
      if (locked.state === "released") return alreadyReleased(locked, this.#date());
      if (locked.state !== "reserved") return notReleasable("ADMISSION_AUTHORIZATION_ALREADY_EFFECTFUL");
      await this.#ports.budget.releaseRoot(transaction, {
        siteId: command.siteId,
        rootHoldRef: locked.rootHoldRef,
        authorizationSegmentRef: locked.authorizationSegmentRef,
        reasonCode: command.effect.reasonCode,
        manifestRef: locked.manifestRef,
        expectedSegmentVersion: locked.segmentVersion,
        commandId: command.commandId,
        requestDigest: command.requestDigest,
        noDispatchEvidenceRef: evidence.evidenceRef,
      });
      const changed = await this.#ports.lifecycle.release(transaction, locked, evidence);
      assertTransition(changed, locked, "released");
      return released(changed, this.#date());
    });
  }

  async reconcileRunAuthorization(
    command: Parameters<AdmissionOwnerAuthority["reconcileRunAuthorization"]>[0],
  ): Promise<ReconcileRunOwnerDecision> {
    const observed = await this.#ports.unitOfWork.execute(command, (transaction) =>
      this.#ports.lifecycle.read(transaction, lifecycleLookup(command)));
    if (observed === null) throw new Error("ADMISSION_AUTHORIZATION_NOT_FOUND");
    assertLifecycleIdentity(observed, command.siteId, command.effect);
    if (observed.segmentVersion === command.effect.expectedSegmentVersion + 1n) {
      if (observed.state === "released") {
        return reconciliation("released_no_effect", observed, this.#date());
      }
      if (observed.state === "reconciliation_required" || observed.state === "settled") {
        return reconciliation(observed.state, observed, this.#date());
      }
    }
    assertExpectedSegmentVersion(observed, command.effect.expectedSegmentVersion);
    let dispatchEvidence: DispatchOwnerEvidence | undefined;
    if (command.effect.sessionDispatchReceiptRef !== undefined) {
      dispatchEvidence = requireDispatchOwnerEvidence(
        await this.#ports.dispatchEvidence.get({
          siteId: command.siteId,
          sessionId: observed.sessionId,
          evidenceRef: command.effect.sessionDispatchReceiptRef,
        }, AbortSignal.timeout(5_000)),
        {
          kind: "outcome_unknown",
          siteId: command.siteId,
          sessionId: observed.sessionId,
          evidenceRef: command.effect.sessionDispatchReceiptRef,
          launchId: observed.launchId,
          runId: observed.runId,
          authorizationSegmentRef: observed.authorizationSegmentRef,
          authorizationSegmentVersion: observed.segmentVersion.toString(),
        },
      );
    }
    const executionEvidence = await this.#ports.executionEvidence.resolve({
      siteId: command.siteId,
      sessionId: observed.sessionId,
      launchId: observed.launchId,
      runId: observed.runId,
      ...(command.effect.gaDurableEventReceiptRef === undefined
        ? {}
        : { gaDurableEventReceiptRef: command.effect.gaDurableEventReceiptRef }),
      ...(command.effect.terminalOwnerEvidenceRef === undefined
        ? {}
        : { terminalOwnerEvidenceRef: command.effect.terminalOwnerEvidenceRef }),
    }, AbortSignal.timeout(5_000));
    if (dispatchEvidence === undefined && executionEvidence.kind === "not_found") {
      return reconciliation("awaiting_owner_evidence", observed, this.#date());
    }
    return this.#ports.unitOfWork.execute(command, async (transaction) => {
      const locked = await this.#ports.lifecycle.lock(transaction, lifecycleLookup(command));
      if (locked === null) throw new Error("ADMISSION_AUTHORIZATION_NOT_FOUND");
      assertSameAuthorization(locked, observed);
      if (locked.state === "released") {
        return reconciliation("released_no_effect", locked, this.#date());
      }
      if (executionEvidence.kind === "execution_observed") {
        return reconciliation(
          "execution_observed",
          locked,
          this.#date(),
          executionEvidence.safeStatusRef,
        );
      }
      if (executionEvidence.kind === "terminal_observed") {
        const budget = await this.#ports.budget.reconcileRoot(transaction, {
          siteId: command.siteId,
          rootHoldRef: locked.rootHoldRef,
          authorizationSegmentRef: locked.authorizationSegmentRef,
          manifestRef: locked.manifestRef,
          expectedSegmentVersion: locked.segmentVersion,
          commandId: command.commandId,
          requestDigest: command.requestDigest,
          terminalEvidenceRef: executionEvidence.terminalEvidenceRef,
        });
        const changed = budget === "settled"
          ? await this.#ports.lifecycle.settle(transaction, locked)
          : await this.#ports.lifecycle.requireReconciliation(transaction, locked);
        return reconciliation(
          budget === "settled" ? "settled" : "reconciliation_required",
          changed,
          this.#date(),
          executionEvidence.safeStatusRef,
        );
      }
      const changed = await this.#ports.lifecycle.requireReconciliation(transaction, locked);
      return reconciliation("reconciliation_required", changed, this.#date());
    });
  }

  #now(): number {
    return this.#date().getTime();
  }

  #date(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("ADMISSION_OWNER_CLOCK_INVALID");
    return value;
  }
}

export function assertPlatformAdmissionOwnerPorts(
  ports: PlatformAdmissionOwnerPorts | undefined,
): asserts ports is PlatformAdmissionOwnerPorts {
  const candidate = ports as Partial<PlatformAdmissionOwnerPorts> | undefined;
  if (
    typeof candidate?.unitOfWork?.execute !== "function" ||
    typeof candidate.session?.resolve !== "function" ||
    typeof candidate.session.verifyFinalizeReceipts !== "function" ||
    typeof candidate.sessionGrant?.resolve !== "function" ||
    typeof candidate.executionBinding?.resolve !== "function" ||
    typeof candidate.site?.resolve !== "function" ||
    typeof candidate.runtimePolicy?.resolve !== "function" ||
    typeof candidate.model?.resolve !== "function" ||
    typeof candidate.capability?.resolve !== "function" ||
    typeof candidate.assets?.validate !== "function" ||
    typeof candidate.budget?.reserveRoot !== "function" ||
    typeof candidate.budget.commitRoot !== "function" ||
    typeof candidate.budget.releaseRoot !== "function" ||
    typeof candidate.budget.reconcileRoot !== "function" ||
    typeof candidate.lifecycle?.prepare !== "function" ||
    typeof candidate.lifecycle.read !== "function" ||
    typeof candidate.lifecycle.lock !== "function" ||
    typeof candidate.lifecycle.commit !== "function" ||
    typeof candidate.lifecycle.expire !== "function" ||
    typeof candidate.lifecycle.release !== "function" ||
    typeof candidate.lifecycle.requireReconciliation !== "function" ||
    typeof candidate.lifecycle.settle !== "function" ||
    typeof candidate.dispatchEvidence?.get !== "function" ||
    typeof candidate.executionEvidence?.resolve !== "function"
  ) throw new Error("PLATFORM_ADMISSION_OWNER_PORTS_REQUIRED");
}

function digestManifest(
  siteId: string,
  effect: PrepareRunEffect,
  ownerFacts: VerifiedGaRunRequestOwnerFacts,
  refs: Readonly<Record<string, string>>,
): string {
  return createHash("sha256").update(JSON.stringify({
    siteId,
    launchId: effect.launchId,
    modelOptionRevisionRef: effect.modelOptionRevisionRef,
    attachmentRefs: effect.attachmentRefs.map((item) => ({
      assetRef: item.assetRef,
      assetVersionRef: item.assetVersionRef,
      assetGrantRef: item.assetGrantRef,
    })),
    ownerFacts,
    refs,
  })).digest("hex");
}

function lifecycleLookup(command: Readonly<{
  siteId: string;
  effect: Readonly<{ manifestRef: string; authorizationSegmentRef: string }>;
}>): Readonly<{ siteId: string; manifestRef: string; authorizationSegmentRef: string }> {
  return {
    siteId: command.siteId,
    manifestRef: command.effect.manifestRef,
    authorizationSegmentRef: command.effect.authorizationSegmentRef,
  };
}

function assertPreparedRecord(
  record: AdmissionAuthorizationRecord,
  command: AdmissionAuthorityCommand & Readonly<{ effect: PrepareRunEffect }>,
  budget: Readonly<{
    rootHoldRef: string;
    authorizationSegmentRef: string;
    segmentVersion: bigint;
    expiresAt: string;
  }>,
  manifestRef: string,
  manifestDigest: string,
  maximumExpiresAt: string,
  now: number,
): void {
  if (
    record.siteId !== command.siteId || record.sessionId !== command.effect.sessionId ||
    record.launchId !== command.effect.launchId || record.runId !== command.effect.proposedRunId ||
    record.rootHoldRef !== budget.rootHoldRef || record.manifestRef !== manifestRef ||
    record.manifestDigest !== manifestDigest ||
    record.authorizationSegmentRef !== budget.authorizationSegmentRef ||
    record.segmentVersion !== budget.segmentVersion || record.expiresAt !== budget.expiresAt ||
    record.state !== "reserved" || record.segmentVersion !== 1n ||
    Date.parse(record.expiresAt) <= now || Date.parse(record.expiresAt) > Date.parse(maximumExpiresAt)
  ) throw new Error("ADMISSION_PREPARED_OWNER_RECORD_INVALID");
}

function assertLifecycleIdentity(
  record: AdmissionAuthorizationRecord,
  siteId: string,
  effect: Readonly<{
    manifestRef: string;
    authorizationSegmentRef: string;
    manifestDigest?: string | undefined;
    launchId?: string | undefined;
  }>,
): void {
  if (
    record.siteId !== siteId || record.manifestRef !== effect.manifestRef ||
    record.authorizationSegmentRef !== effect.authorizationSegmentRef ||
    (effect.manifestDigest !== undefined && record.manifestDigest !== effect.manifestDigest) ||
    (effect.launchId !== undefined && record.launchId !== effect.launchId)
  ) throw new Error("ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
}

function assertExpectedSegmentVersion(
  record: AdmissionAuthorizationRecord,
  expectedSegmentVersion: bigint,
): void {
  if (record.segmentVersion !== expectedSegmentVersion) {
    throw new Error("ADMISSION_AUTHORIZATION_OWNER_MISMATCH");
  }
}

function assertSameAuthorization(
  current: AdmissionAuthorizationRecord,
  observed: AdmissionAuthorizationRecord,
): void {
  if (
    current.siteId !== observed.siteId || current.manifestRef !== observed.manifestRef ||
    current.manifestDigest !== observed.manifestDigest || current.sessionId !== observed.sessionId ||
    current.launchId !== observed.launchId || current.runId !== observed.runId ||
    current.rootHoldRef !== observed.rootHoldRef ||
    current.authorizationSegmentRef !== observed.authorizationSegmentRef ||
    current.segmentVersion !== observed.segmentVersion
  ) throw new Error("ADMISSION_AUTHORIZATION_CHANGED");
}

function assertTransition(
  changed: AdmissionAuthorizationRecord,
  prior: AdmissionAuthorizationRecord,
  state: AdmissionAuthorizationState,
): void {
  if (
    changed.siteId !== prior.siteId || changed.authorizationSegmentRef !== prior.authorizationSegmentRef ||
    changed.manifestRef !== prior.manifestRef || changed.state !== state ||
    changed.segmentVersion !== prior.segmentVersion + 1n
  ) throw new Error("ADMISSION_AUTHORIZATION_TRANSITION_INVALID");
}

function denied(code: string): Denied {
  return { kind: "denied", denial: { code, retryClass: AdmissionRetryClass.NEVER } };
}

function notReleasable(code: string): ReleaseRunOwnerDecision {
  return { kind: "not_releasable", notReleasable: { code } };
}

function replayFinalized(
  record: AdmissionAuthorizationRecord,
  expectedSegmentVersion: bigint,
  at: Date,
): FinalizeRunOwnerDecision | null {
  if (record.segmentVersion !== expectedSegmentVersion + 1n) return null;
  if (record.state === "committed") return committed(record, at);
  if (record.state === "expired") {
    return { kind: "expired", expired: { expiredAt: timestampFromDate(at) } };
  }
  return null;
}

function committed(record: AdmissionAuthorizationRecord, at: Date): FinalizeRunOwnerDecision {
  return {
    kind: "committed",
    committed: {
      authorizationSegmentRef: record.authorizationSegmentRef,
      segmentVersion: record.segmentVersion,
      committedAt: timestampFromDate(at),
    },
  };
}

function released(record: AdmissionAuthorizationRecord, at: Date): ReleaseRunOwnerDecision {
  return {
    kind: "released",
    released: {
      authorizationSegmentRef: record.authorizationSegmentRef,
      segmentVersion: record.segmentVersion,
      releasedAt: timestampFromDate(at),
    },
  };
}

function alreadyReleased(record: AdmissionAuthorizationRecord, at: Date): ReleaseRunOwnerDecision {
  return {
    kind: "already_released",
    released: {
      authorizationSegmentRef: record.authorizationSegmentRef,
      segmentVersion: record.segmentVersion,
      releasedAt: timestampFromDate(at),
    },
  };
}

function reconciliation(
  kind: Exclude<ReconcileRunOwnerDecision["kind"], "pending" | "outcome_unknown">,
  record: AdmissionAuthorizationRecord,
  at: Date,
  safeStatusRef?: string,
): ReconcileRunOwnerDecision {
  return {
    kind,
    result: {
      authorizationSegmentRef: record.authorizationSegmentRef,
      segmentVersion: record.segmentVersion,
      observedAt: timestampFromDate(at),
      ...(safeStatusRef === undefined ? {} : { safeStatusRef }),
    },
  };
}
