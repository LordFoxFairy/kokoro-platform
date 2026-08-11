import type { ProjectMembershipCurrentFact, SubjectCurrentFact } from
  "../../../authorization/application/contracts/scoped-session-authorization-port.js";
import { normalizeIdentityEmail } from "../../domain/identity-email.js";
import type { IdentityRepository } from "../contracts/identity-repository.js";
import type { IdentityAuditDigesterPort, IdentityPasswordHasherPort } from
  "../contracts/identity-security-ports.js";
import type { IdentityCommandReceiptPort, IdentityOutboxPort, IdentityUnitOfWorkPort } from
  "./identity-application-service.js";
import type { PersonalBootstrapAuthorizationMutation } from "./personal-bootstrap-authorization-mutation.js";
import { assertVerifiedRequestSecurityContext, type VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";

const OPERATION = "identity.bootstrap-verified-personal-account";
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;

type BootstrapIdentityRepository = Pick<IdentityRepository, "createVerification" | "activateVerification">;
type BootstrapAuthorizationMutation = Pick<PersonalBootstrapAuthorizationMutation, "execute">;

export type BootstrapVerifiedPersonalAccountDependencies = Readonly<{
  unitOfWork: IdentityUnitOfWorkPort;
  repository: BootstrapIdentityRepository;
  receipts: IdentityCommandReceiptPort;
  passwordHasher: IdentityPasswordHasherPort;
  authorizationMutation: BootstrapAuthorizationMutation;
  outbox: IdentityOutboxPort;
  auditDigest: IdentityAuditDigesterPort;
  clock?: () => Date;
}>;

export type BootstrapVerifiedPersonalAccountInput = Readonly<{
  commandId: string;
  idempotencyKey: string;
  requestDigest: string;
  siteRef: string;
  email: string;
  password: string;
  displayName: string;
  accountRef: string;
  subjectRef: string;
  workspaceRef: string;
  projectRef: string;
  billingAccountRef: string;
  executionSpaceRef: string;
  executionNamespace: string;
  verificationTransactionRef: string;
  namespaceIntentRef: string;
  namespaceEventId: string;
}>;

export type BootstrapVerifiedPersonalAccountResult = Readonly<{
  accountRef: string;
  subjectRef: string;
  workspaceRef: string;
  projectRef: string;
  billingAccountRef: string;
  executionSpaceRef: string;
  executionNamespace: string;
}>;

export class BootstrapVerifiedPersonalAccountService {
  constructor(private readonly dependencies: BootstrapVerifiedPersonalAccountDependencies) {}

  async bootstrap(
    input: BootstrapVerifiedPersonalAccountInput,
    verifiedAdminContext: VerifiedRequestSecurityContext,
  ): Promise<BootstrapVerifiedPersonalAccountResult> {
    const clock = this.dependencies.clock ?? (() => new Date());
    assertVerifiedRequestSecurityContext(verifiedAdminContext, clock().toISOString());
    if (
      verifiedAdminContext.trustedCaller.kind !== "admin_workload" ||
      verifiedAdminContext.actor.kind !== "operator" ||
      !verifiedAdminContext.trustedCaller.allowedOperations.includes(OPERATION)
    ) throw new Error("IDENTITY_BOOTSTRAP_ADMIN_REQUIRED");
    validateInput(input);
    const emailNormalized = normalizeIdentityEmail(input.email);
    const password = await this.dependencies.passwordHasher.hash(input.password);
    return this.dependencies.unitOfWork.execute(
      { context: verifiedAdminContext, operation: OPERATION },
      async (transaction) => {
        const identity = {
          commandId: input.commandId,
          environment: verifiedAdminContext.environment,
          region: verifiedAdminContext.region,
          callerIdentity: `${verifiedAdminContext.trustedCaller.workloadIdentityId}:${verifiedAdminContext.actor.subjectId}`,
          operation: OPERATION,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
        } as const;
        const receipt = await this.dependencies.receipts.begin(transaction, identity);
        if (receipt.commandId !== input.commandId) throw new Error("COMMAND_IDENTITY_CONFLICT");
        if (receipt.state === "succeeded") return resultFromJson(receipt.result);
        if (receipt.state !== "pending" && receipt.state !== "outcome_unknown") {
          throw new Error("IDENTITY_BOOTSTRAP_RECEIPT_TERMINAL");
        }
        const now = clock().toISOString();
        const created = await this.dependencies.repository.createVerification(transaction, {
          siteRef: input.siteRef,
          accountRef: input.accountRef,
          subjectRef: input.subjectRef,
          transactionRef: input.verificationTransactionRef,
          emailNormalized,
          passwordHash: password.passwordHash,
          pepperVersion: password.pepperVersion,
          secretDigest: input.requestDigest,
          requestDigest: input.requestDigest,
          expiresAt: new Date(Date.parse(now) + 300_000).toISOString(),
          acceptedAt: now,
          legalAcceptances: [],
        });
        if (created !== "created") throw new Error("IDENTITY_BOOTSTRAP_ACCOUNT_CONFLICT");
        await this.dependencies.authorizationMutation.execute(
          transaction,
          { siteRef: input.siteRef, correlationId: verifiedAdminContext.correlationId },
          async (): Promise<Readonly<{ subject: SubjectCurrentFact; membership: ProjectMembershipCurrentFact }>> => {
            const payload = ownerJson({
              kind: "identity_namespace_allocation_v1",
              siteRef: input.siteRef,
              subjectRef: input.subjectRef,
              workspaceRef: input.workspaceRef,
              projectRef: input.projectRef,
              executionSpaceRef: input.executionSpaceRef,
              executionNamespace: input.executionNamespace,
              namespaceIntentRef: input.namespaceIntentRef,
            });
            await this.dependencies.outbox.enqueue(transaction, {
              eventId: input.namespaceEventId,
              owner: "identity",
              eventType: "identity.namespace.allocation.requested",
              aggregateId: input.executionSpaceRef,
              payload,
              payloadDigest: this.dependencies.auditDigest(payload),
              correlationId: verifiedAdminContext.correlationId,
              causationId: input.commandId,
            });
            return this.dependencies.repository.activateVerification(transaction, {
              siteRef: input.siteRef,
              transactionRef: input.verificationTransactionRef,
              accountRef: input.accountRef,
              subjectRef: input.subjectRef,
              now,
              displayName: input.displayName,
              workspaceRef: input.workspaceRef,
              billingAccountRef: input.billingAccountRef,
              projectRef: input.projectRef,
              executionSpaceRef: input.executionSpaceRef,
              executionNamespace: input.executionNamespace,
              namespaceIntentRef: input.namespaceIntentRef,
              namespaceEventId: input.namespaceEventId,
            });
          },
        );
        const result = ownerResult(input);
        await this.dependencies.receipts.recordOutcome(transaction, identity, {
          state: "succeeded",
          result: ownerJson(result),
          resultDigest: this.dependencies.auditDigest(ownerJson(result)),
        });
        return result;
      },
    );
  }
}

function validateInput(input: BootstrapVerifiedPersonalAccountInput): void {
  const stable = [input.siteRef, input.subjectRef, input.workspaceRef,
    input.projectRef, input.billingAccountRef, input.executionSpaceRef, input.executionNamespace];
  if (
    !UUID.test(input.commandId) || !SHA256.test(input.requestDigest) ||
    !UUID.test(input.accountRef) || !UUID.test(input.verificationTransactionRef) ||
    !UUID.test(input.namespaceIntentRef) || !UUID.test(input.namespaceEventId) ||
    stable.some((value) => !REFERENCE.test(value)) ||
    input.displayName.length < 1 || input.displayName.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.displayName) ||
    !/^[A-Za-z0-9:._/-]{8,512}$/u.test(input.idempotencyKey) ||
    input.password.length < 15 || input.password.length > 1024 || /[\u0000\r\n]/u.test(input.password)
  ) throw new Error("IDENTITY_BOOTSTRAP_INPUT_INVALID");
}

function ownerResult(input: BootstrapVerifiedPersonalAccountInput): BootstrapVerifiedPersonalAccountResult {
  return Object.freeze({ accountRef: input.accountRef, subjectRef: input.subjectRef,
    workspaceRef: input.workspaceRef, projectRef: input.projectRef,
    billingAccountRef: input.billingAccountRef, executionSpaceRef: input.executionSpaceRef,
    executionNamespace: input.executionNamespace });
}

function resultFromJson(value: JsonValue | null): BootstrapVerifiedPersonalAccountResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IDENTITY_BOOTSTRAP_RECEIPT_INVALID");
  }
  const expected = ["accountRef", "subjectRef", "workspaceRef", "projectRef", "billingAccountRef",
    "executionSpaceRef", "executionNamespace"] as const;
  if (Object.keys(value).length !== expected.length ||
      expected.some((key) => typeof value[key] !== "string" || !REFERENCE.test(value[key]))) {
    throw new Error("IDENTITY_BOOTSTRAP_RECEIPT_INVALID");
  }
  return Object.freeze(Object.fromEntries(expected.map((key) => [key, value[key]])) as
    BootstrapVerifiedPersonalAccountResult);
}

function ownerJson(value: Readonly<Record<string, string>>): JsonValue {
  return Object.freeze({ ...value });
}
