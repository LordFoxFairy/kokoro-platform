import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import {
  isDeploymentEnvironment,
  type DeploymentEnvironment,
} from "../../../../shared/deployment-environment.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import {
  beginSiteTrafficStop,
  observeSiteTrafficStop,
  recordSiteTrafficStopEffectFailure,
  requestSiteTrafficStopEffect,
} from "../../domain/site-traffic-stop.js";
import type { SiteAuthorityJournal, SiteAuthorityReceipt } from "../contracts/site-authority-ports.js";
import type { SiteTrafficStopRepository } from "../contracts/site-traffic-stop-ports.js";
import {
  siteTrafficStopEffectDigest,
  type SiteEffectApprovalAuthority,
} from "../contracts/site-effect-approval.js";
import { createSiteAuthorityCommand } from "../site-command.js";
import { SiteCurrentAuthorizationMutation } from "./site-current-authorization-mutation.js";

type CommandInput = Readonly<{ commandId: string; idempotencyKey: string }>;

export class SiteTrafficStopService {
  readonly #now: () => string;
  readonly #approvalAuthority: SiteEffectApprovalAuthority;
  readonly #authorization: SiteCurrentAuthorizationMutation;

  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SiteTrafficStopRepository,
    private readonly journal: SiteAuthorityJournal,
    options: Readonly<{
      now?: () => string;
      approvalAuthority?: SiteEffectApprovalAuthority;
      authorization?: SiteCurrentAuthorizationMutation;
    }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#approvalAuthority = options.approvalAuthority ?? denyApprovalAuthority;
    this.#authorization = options.authorization ?? denyAuthorizationMutation;
  }

  requestTrafficStop(
    input: CommandInput & Readonly<{
      attemptRef: string; approvalRef: string; siteRef: string; action: "suspend" | "decommission";
      reason: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    admin(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.traffic-stop.request", input.siteRef, input, context, {
      attemptRef: input.attemptRef, action: input.action,
      reason: input.reason,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const existing = await this.repository.loadTrafficStopForUpdate(transaction, input.attemptRef);
      if (disposition === "replay") {
        if (existing === null || existing.siteRef !== input.siteRef || existing.action !== input.action) {
          throw new Error("SITE_TRAFFIC_STOP_REPLAY_CONFLICT");
        }
        return Object.freeze({ attemptRef: existing.attemptRef, state: existing.state, replayed: true });
      }
      if (existing !== null) throw new Error("SITE_TRAFFIC_STOP_REF_CONFLICT");
      await this.#approvalAuthority.consume(transaction, {
        approvalRef: input.approvalRef,
        siteRef: input.siteRef,
        operation: `site.traffic-stop.${input.action}`,
        environment: context.environment,
        region: context.region,
        effectDigest: siteTrafficStopEffectDigest(input),
      }, context);
      let result: ReturnType<typeof beginSiteTrafficStop> | undefined;
      await this.#authorization.execute(transaction, {
        siteRef: input.siteRef,
        correlationId: context.correlationId,
      }, async () => {
        const site = await this.repository.loadSiteForUpdate(transaction, input.siteRef);
        const environment = deploymentEnvironment(context);
        const deployment = await this.repository.loadActiveDeploymentForUpdate(
          transaction, input.siteRef, environment, context.region,
        );
        if (site === null || deployment === null) throw new Error("SITE_TRAFFIC_STOP_TARGET_NOT_FOUND");
        result = beginSiteTrafficStop({
          attemptRef: input.attemptRef, action: input.action, site, deployment,
          providerNamespace: deployment.providerNamespace, requestedAt: this.#now(),
        });
        await this.repository.beginTrafficStop(transaction, result.site, result.attempt);
      });
      if (result === undefined) throw new Error("SITE_TRAFFIC_STOP_MUTATION_INCOMPLETE");
      const receipt = Object.freeze({ attemptRef: result.attempt.attemptRef,
        state: result.attempt.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  armProviderEffect(
    input: CommandInput & Readonly<{ attemptRef: string; siteRef: string; providerOperationKey: string }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    return this.updateFromWorker("site.traffic-stop.arm", input, context, (attempt) =>
      requestSiteTrafficStopEffect(attempt, input.providerOperationKey));
  }

  recordProviderFailure(
    input: CommandInput & Readonly<{
      attemptRef: string; siteRef: string; outcome: "failed" | "unknown"; failureCode: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    return this.updateFromWorker("site.traffic-stop.effect-failure", input, context, (attempt) =>
      recordSiteTrafficStopEffectFailure(attempt, input.outcome, input.failureCode));
  }

  observeProvider(
    input: CommandInput & Readonly<{
      attemptRef: string; siteRef: string; providerOperationKey: string; deploymentRef: string;
      status: "serving" | "stopped" | "unknown"; observedAt: string; providerPayloadDigest: string;
    }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteAuthorityReceipt> {
    worker(context, input.siteRef);
    const command = createSiteAuthorityCommand("site.traffic-stop.observe", input.siteRef, input, context, {
      attemptRef: input.attemptRef, providerOperationKey: input.providerOperationKey,
      deploymentRef: input.deploymentRef, status: input.status, observedAt: input.observedAt,
      providerPayloadDigest: input.providerPayloadDigest,
    });
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadTrafficStopForUpdate(transaction, input.attemptRef);
      if (current === null || current.siteRef !== input.siteRef) throw new Error("SITE_TRAFFIC_STOP_NOT_FOUND");
      if (disposition === "replay") {
        return Object.freeze({ attemptRef: current.attemptRef, state: current.state, replayed: true });
      }
      const observation = Object.freeze({
        observationRef: input.commandId, attemptRef: input.attemptRef,
        providerOperationKey: input.providerOperationKey, deploymentRef: input.deploymentRef,
        status: input.status, observedAt: input.observedAt, payloadDigest: input.providerPayloadDigest,
      });
      const result = observeSiteTrafficStop(current, observation);
      await this.repository.recordTrafficStopObservation(transaction, observation, result.attempt, result.site);
      const receipt = Object.freeze({ attemptRef: result.attempt.attemptRef,
        state: result.attempt.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }

  private updateFromWorker(
    operation: string,
    input: CommandInput & Readonly<{ attemptRef: string; siteRef: string }>,
    context: VerifiedRequestSecurityContext,
    update: (attempt: NonNullable<Awaited<ReturnType<SiteTrafficStopRepository["loadTrafficStopForUpdate"]>>>) =>
      NonNullable<Awaited<ReturnType<SiteTrafficStopRepository["loadTrafficStopForUpdate"]>>>,
  ): Promise<SiteAuthorityReceipt> {
    worker(context, input.siteRef);
    const command = createSiteAuthorityCommand(operation, input.siteRef, input, context, { ...input });
    return this.unitOfWork.execute({ context, operation }, async (transaction) => {
      const disposition = await this.journal.begin(transaction, command);
      const current = await this.repository.loadTrafficStopForUpdate(transaction, input.attemptRef);
      if (current === null || current.siteRef !== input.siteRef) throw new Error("SITE_TRAFFIC_STOP_NOT_FOUND");
      if (disposition === "replay") {
        return Object.freeze({ attemptRef: current.attemptRef, state: current.state, replayed: true });
      }
      const next = update(current);
      await this.repository.updateTrafficStop(transaction, next);
      const receipt = Object.freeze({ attemptRef: next.attemptRef, state: next.state, replayed: false });
      await this.journal.succeed(transaction, command, receipt, context);
      return receipt;
    });
  }
}

const denyApprovalAuthority: SiteEffectApprovalAuthority = Object.freeze({
  consume: async () => { throw new Error("SITE_EFFECT_APPROVAL_AUTHORITY_REQUIRED"); },
});

const denyAuthorizationMutation = Object.freeze({
  execute: async (): Promise<never> => { throw new Error("SITE_AUTHORIZATION_MUTATION_REQUIRED"); },
}) as unknown as SiteCurrentAuthorizationMutation;

function admin(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("SITE_ADMIN_OPERATOR_REQUIRED");
  }
  if (context.target.siteId !== siteRef) throw new Error("SITE_ADMIN_SCOPE_MISMATCH");
}
function worker(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "platform_worker" || context.actor.kind !== "workload") {
    throw new Error("SITE_WORKER_REQUIRED");
  }
  if (context.target.siteId !== siteRef) throw new Error("SITE_WORKER_SCOPE_MISMATCH");
}
function deploymentEnvironment(context: VerifiedRequestSecurityContext): DeploymentEnvironment {
  if (!isDeploymentEnvironment(context.environment)) {
    throw new Error("SITE_ENVIRONMENT_INVALID");
  }
  return context.environment;
}
