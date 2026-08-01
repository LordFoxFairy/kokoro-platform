import { canonicalCommandId } from "../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { ImmutableRevisionBinding } from "../domain/product-publication.js";

export type ProductPublicationOperation =
  | "product.catalog.publish"
  | "product.launch-profile.publish";

export interface ProductPublicationReceipt {
  readonly binding: ImmutableRevisionBinding;
  readonly replayed: boolean;
}

export interface ProductPublicationCommand {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly operation: ProductPublicationOperation;
  readonly binding: ImmutableRevisionBinding;
  readonly catalogBinding: ImmutableRevisionBinding | null;
  readonly expectedHeadRevision: bigint;
  readonly reason: string;
  readonly security: Readonly<{
    environment: string;
    region: string;
    callerIdentity: string;
    actorSubjectId: string;
  }>;
}

export function createProductPublicationCommand(input: Readonly<{
  commandId: string;
  idempotencyKey?: string;
  requestDigest: string;
  operation: ProductPublicationOperation;
  binding: ImmutableRevisionBinding;
  catalogBinding?: ImmutableRevisionBinding;
  expectedHeadRevision: bigint;
  reason: string;
}>, context: VerifiedRequestSecurityContext): ProductPublicationCommand {
  const commandId = canonicalCommandId(input.commandId);
  const idempotencyKey = input.idempotencyKey ?? commandId;
  if (idempotencyKey.length < 16 || idempotencyKey.length > 256 || hasControl(idempotencyKey)) {
    throw new Error("PRODUCT_PUBLICATION_IDEMPOTENCY_KEY_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) {
    throw new Error("PRODUCT_PUBLICATION_REQUEST_DIGEST_INVALID");
  }
  if (input.reason.length < 3 || input.reason.length > 1024 || hasControl(input.reason)) {
    throw new Error("PRODUCT_PUBLICATION_REASON_INVALID");
  }
  if (input.expectedHeadRevision < 0n || input.expectedHeadRevision > 18_446_744_073_709_551_615n) {
    throw new Error("PRODUCT_PUBLICATION_EXPECTED_HEAD_INVALID");
  }
  assertPublicationContext(context, input.operation);
  return Object.freeze({
    ...input,
    commandId,
    idempotencyKey,
    catalogBinding: input.catalogBinding ?? null,
    security: Object.freeze({
      environment: context.environment,
      region: context.region,
      callerIdentity: context.trustedCaller.workloadIdentityId,
      actorSubjectId: context.actor.subjectId,
    }),
  });
}

function assertPublicationContext(
  context: VerifiedRequestSecurityContext,
  operation: ProductPublicationOperation,
): void {
  if (context.trustedCaller.kind !== "admin_workload") {
    throw new Error("PRODUCT_PUBLICATION_ADMIN_WORKLOAD_REQUIRED");
  }
  if (context.actor.kind !== "operator" || context.target.siteId !== null) {
    throw new Error("PRODUCT_PUBLICATION_GLOBAL_OPERATOR_REQUIRED");
  }
  if (context.target.purpose !== operation ||
      !context.target.scopes.includes("admin:global") ||
      !context.target.scopes.includes(operation)) {
    throw new Error("PRODUCT_PUBLICATION_SECURITY_SCOPE_INVALID");
  }
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
