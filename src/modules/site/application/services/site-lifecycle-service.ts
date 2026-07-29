import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import {
  activateObservedRelease,
  beginActivation,
  beginDecommission,
  completeActivationDrain,
  deploymentBindingForObservation,
  observePromotion,
  requestPromotion,
  resumeSite,
  suspendSite,
} from "../../domain/site-lifecycle.js";
import type {
  SiteAuthorityCommand,
  SiteAuthorityJournal,
  SiteAuthorityReceipt,
  SiteAuthorityRepository,
} from "../contracts/site-authority-ports.js";
import { createSiteAuthorityCommand } from "../site-command.js";

interface CommandInput {
  readonly commandId: string;
  readonly idempotencyKey: string;
}

export class SiteLifecycleService {
  readonly #now: () => string;

  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SiteAuthorityRepository,
    private readonly journal: SiteAuthorityJournal,
    options: Readonly<{ now?: () => string }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  beginActivation(
    input: CommandInput & Readonly<{
      attemptRef: string;
      siteRef: string;
      candidateReleaseRef: string;
      expectedActiveReleaseRef: string | null;
      audience: string;
      sessionContractRevision: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    admin(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.activation.begin", input.siteRef, input, context, {
      attemptRef: input.attemptRef,
      candidateReleaseRef: input.candidateReleaseRef,
      expectedActiveReleaseRef: input.expectedActiveReleaseRef,
      audience: input.audience,
      sessionContractRevision: input.sessionContractRevision,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const environment = deploymentEnvironment(context);
      const disposition = await this.journal.begin(transaction, command);
      const existing = await this.repository.loadActivationForUpdate(transaction, input.attemptRef);
      if (disposition === "replay") {
        if (existing === null || existing.siteRef !== input.siteRef ||
            existing.candidateReleaseRef !== input.candidateReleaseRef ||
            existing.expectedActiveReleaseRef !== input.expectedActiveReleaseRef ||
            existing.audience !== input.audience ||
            existing.sessionContractRevision !== input.sessionContractRevision) {
          throw new Error("SITE_ACTIVATION_REPLAY_CONFLICT");
        }
        return Object.freeze({ attemptRef: existing.attemptRef, state: existing.state, replayed: true });
      }
      if (existing !== null) throw new Error("SITE_ACTIVATION_REF_CONFLICT");
      const site = await this.repository.loadSiteForUpdate(transaction, input.siteRef);
      const candidate = await this.repository.loadReleaseForUpdate(
        transaction,
        input.siteRef,
        input.candidateReleaseRef,
      );
      const binding = await this.repository.loadActiveProjectBindingForUpdate(
        transaction,
        input.siteRef,
        environment,
      );
      if (site === null || candidate === null || binding === null) {
        throw new Error("SITE_ACTIVATION_TARGET_NOT_FOUND");
      }
      const attempt = beginActivation({
        attemptRef: input.attemptRef,
        site,
        candidate,
        expectedActiveReleaseRef: input.expectedActiveReleaseRef,
        siteProjectBindingRef: binding.bindingRef,
        siteProjectBindingEpoch: binding.bindingEpoch,
        environment,
        region: context.region,
        audience: input.audience,
        sessionContractRevision: input.sessionContractRevision,
        requestedAt: this.#now(),
      });
      await this.repository.insertActivation(transaction, attempt);
      const receipt = Object.freeze({ attemptRef: attempt.attemptRef, state: attempt.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  requestActivationPromotion(
    input: CommandInput & Readonly<{
      attemptRef: string;
      siteRef: string;
      providerOperationKey: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    worker(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.activation.request-promotion", input.siteRef, input, context, {
      attemptRef: input.attemptRef,
      providerOperationKey: input.providerOperationKey,
    });
    return this.updateAttempt(command, context, input.attemptRef, (attempt) =>
      requestPromotion(attempt, input.providerOperationKey));
  }

  observeActivation(
    input: CommandInput & Readonly<{
      attemptRef: string;
      providerOperationKey: string;
      deploymentRef: string;
      releaseRef: string;
      webArtifactDigest: string;
      healthy: boolean;
      trafficReady: boolean;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    const siteRef = targetSite(context);
    worker(context, siteRef);
    const command = createSiteAuthorityCommand("site.activation.observe", siteRef, input, context, {
      attemptRef: input.attemptRef,
      providerOperationKey: input.providerOperationKey,
      deploymentRef: input.deploymentRef,
      releaseRef: input.releaseRef,
      webArtifactDigest: input.webArtifactDigest,
      healthy: input.healthy,
      trafficReady: input.trafficReady,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadActivationForUpdate(transaction, input.attemptRef);
      if (current === null || current.siteRef !== siteRef) throw new Error("SITE_ACTIVATION_NOT_FOUND");
      if (disposition === "replay") {
        return Object.freeze({ attemptRef: current.attemptRef, state: current.state, replayed: true });
      }
      if (current.environment !== context.environment || current.region !== context.region) {
        throw new Error("SITE_ACTIVATION_RUNTIME_SCOPE_MISMATCH");
      }
      const observedAt = this.#now();
      const observation = Object.freeze({
        observationRef: input.commandId,
        attemptRef: input.attemptRef,
        providerOperationKey: input.providerOperationKey,
        deploymentRef: input.deploymentRef,
        releaseRef: input.releaseRef,
        webArtifactDigest: input.webArtifactDigest,
        healthy: input.healthy,
        trafficReady: input.trafficReady,
        observedAt,
        payloadDigest: command.requestDigest,
      });
      const next = observePromotion(current, observation);
      const deployment = deploymentBindingForObservation(current, observation);
      await this.repository.recordObservationAndCandidateDeployment(transaction, observation, deployment);
      await this.repository.updateActivation(transaction, next);
      const receipt = Object.freeze({ attemptRef: next.attemptRef, state: next.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  commitActivation(
    input: CommandInput & Readonly<{ attemptRef: string; siteRef: string }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    worker(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.activation.commit", input.siteRef, input, context, {
      attemptRef: input.attemptRef,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const attempt = await this.repository.loadActivationForUpdate(transaction, input.attemptRef);
      if (attempt === null || attempt.siteRef !== input.siteRef) throw new Error("SITE_ACTIVATION_NOT_FOUND");
      if (disposition === "replay" && (attempt.state === "draining" || attempt.state === "succeeded")) {
        return Object.freeze({ attemptRef: attempt.attemptRef, state: attempt.state, replayed: true });
      }
      const site = await this.repository.loadSiteForUpdate(transaction, input.siteRef);
      const candidate = await this.repository.loadReleaseForUpdate(
        transaction,
        input.siteRef,
        attempt.candidateReleaseRef,
      );
      if (site === null || candidate === null) throw new Error("SITE_ACTIVATION_TARGET_NOT_FOUND");
      const result = activateObservedRelease({
        site,
        candidate,
        attempt,
        currentActiveReleaseRef: site.activeReleaseRef,
        committedAt: this.#now(),
      });
      await this.repository.commitActivation(transaction, {
        ...result,
        expectedActiveReleaseRef: attempt.expectedActiveReleaseRef,
      });
      const receipt = Object.freeze({ attemptRef: result.attempt.attemptRef,
        state: result.attempt.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  completeActivationDrain(
    input: CommandInput & Readonly<{
      attemptRef: string;
      siteRef: string;
      providerOperationKey: string;
      deploymentRef: string;
      releaseRef: string;
      webArtifactDigest: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    worker(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.activation.complete-drain", input.siteRef, input, context, {
      attemptRef: input.attemptRef,
      providerOperationKey: input.providerOperationKey,
      deploymentRef: input.deploymentRef,
      releaseRef: input.releaseRef,
      webArtifactDigest: input.webArtifactDigest,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadActivationForUpdate(transaction, input.attemptRef);
      if (current === null || current.siteRef !== input.siteRef) throw new Error("SITE_ACTIVATION_NOT_FOUND");
      if (disposition === "replay" && current.state === "succeeded") {
        return Object.freeze({ attemptRef: current.attemptRef, state: current.state, replayed: true });
      }
      if (current.expectedActiveReleaseRef === null || current.environment !== deploymentEnvironment(context) ||
          current.region !== context.region || current.expectedActiveReleaseRef !== input.releaseRef) {
        throw new Error("SITE_DRAIN_SCOPE_MISMATCH");
      }
      const deployment = await this.repository.loadDrainingDeploymentForUpdate(
        transaction,
        input.siteRef,
        current.environment,
        current.expectedActiveReleaseRef,
      );
      if (deployment === null || deployment.deploymentRef !== input.deploymentRef ||
          deployment.webArtifactDigest !== input.webArtifactDigest) {
        throw new Error("SITE_DRAIN_DEPLOYMENT_MISMATCH");
      }
      const observation = Object.freeze({
        observationRef: input.commandId,
        attemptRef: input.attemptRef,
        providerOperationKey: input.providerOperationKey,
        deploymentRef: input.deploymentRef,
        releaseRef: input.releaseRef,
        webArtifactDigest: input.webArtifactDigest,
        healthy: false,
        trafficReady: false,
        observedAt: this.#now(),
        payloadDigest: command.requestDigest,
      });
      const next = completeActivationDrain(current, observation);
      await this.repository.recordDrainObservationAndComplete(transaction, observation, next);
      const receipt = Object.freeze({ attemptRef: next.attemptRef, state: next.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  changeSiteState(
    input: CommandInput & Readonly<{ siteRef: string; action: "suspend" | "resume" | "decommission" }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    admin(context, input.siteRef);
    const operation = `site.${input.action}`;
    const command = createSiteAuthorityCommand(operation, input.siteRef, input, context, { action: input.action });
    return this.unitOfWork.execute({ context, operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadSiteForUpdate(transaction, input.siteRef);
      if (current === null) throw new Error("SITE_NOT_FOUND");
      if (disposition === "replay") {
        return Object.freeze({ siteRef: current.siteRef, state: current.state, replayed: true });
      }
      const next = input.action === "suspend" ? suspendSite(current) :
        input.action === "resume" ? resumeSite(current) : beginDecommission(current);
      await this.repository.updateSite(transaction, next);
      const receipt = Object.freeze({ siteRef: next.siteRef, state: next.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  private updateAttempt(
    command: SiteAuthorityCommand,
    context: VerifiedRequestSecurityContext,
    attemptRef: string,
    update: (attempt: Parameters<typeof requestPromotion>[0]) => Parameters<typeof requestPromotion>[0],
  ): Promise<SiteAuthorityReceipt> {
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadActivationForUpdate(transaction, attemptRef);
      if (current === null || current.siteRef !== command.siteRef) throw new Error("SITE_ACTIVATION_NOT_FOUND");
      if (disposition === "replay") {
        return Object.freeze({ attemptRef: current.attemptRef, state: current.state, replayed: true });
      }
      const next = update(current);
      await this.repository.updateActivation(transaction, next);
      const receipt = Object.freeze({ attemptRef: next.attemptRef, state: next.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }
}

function admin(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("SITE_ADMIN_OPERATOR_REQUIRED");
  }
  if (targetSite(context) !== siteRef) throw new Error("SITE_ADMIN_SCOPE_MISMATCH");
}

function worker(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "platform_worker" || context.actor.kind !== "workload") {
    throw new Error("SITE_WORKER_REQUIRED");
  }
  if (targetSite(context) !== siteRef) throw new Error("SITE_WORKER_SCOPE_MISMATCH");
}

function targetSite(context: VerifiedRequestSecurityContext): string {
  const siteRef = context.target.siteId;
  if (siteRef === null) throw new Error("SITE_SCOPE_REQUIRED");
  return siteRef;
}

function deploymentEnvironment(
  context: VerifiedRequestSecurityContext,
): "development" | "preview" | "production" {
  if (context.environment !== "development" && context.environment !== "preview" && context.environment !== "production") {
    throw new Error("SITE_ENVIRONMENT_INVALID");
  }
  return context.environment;
}
