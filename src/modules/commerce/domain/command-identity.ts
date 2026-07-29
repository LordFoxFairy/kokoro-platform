const SHA256 = /^[a-f0-9]{64}$/u;
const COMMAND_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u;

export interface CommerceCommandIdentity {
  readonly commandId: string;
  readonly environment: string;
  readonly region: string;
  readonly siteId: string;
  readonly actorKind: "anonymous" | "user" | "operator" | "workload";
  readonly actorSubject: string;
  readonly actorGeneration: string;
  readonly callerIdentity: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly commandVersion: string;
  readonly requestDigest: string;
}

export type CommerceCommandIdentityInput = Omit<CommerceCommandIdentity, "callerIdentity">;

export function createCommerceCommandIdentity(input: CommerceCommandIdentityInput): CommerceCommandIdentity {
  bounded(input.environment, 64, "COMMAND_ENVIRONMENT_INVALID");
  bounded(input.region, 128, "COMMAND_REGION_INVALID");
  bounded(input.siteId, 256, "COMMAND_SITE_INVALID");
  bounded(input.actorSubject, 256, "COMMAND_ACTOR_INVALID");
  if (!["anonymous", "user", "operator", "workload"].includes(input.actorKind)) throw new Error("COMMAND_ACTOR_KIND_INVALID");
  if (!/^[1-9][0-9]*$/u.test(input.actorGeneration)) throw new Error("COMMAND_ACTOR_GENERATION_INVALID");
  bounded(input.operation, 160, "COMMAND_OPERATION_INVALID");
  bounded(input.idempotencyKey, 256, "IDEMPOTENCY_KEY_INVALID");
  bounded(input.commandVersion, 64, "COMMAND_VERSION_INVALID");
  if (!COMMAND_ID.test(input.commandId)) throw new Error("COMMAND_ID_INVALID");
  if (!SHA256.test(input.requestDigest)) throw new Error("SHA256_DIGEST_REQUIRED");
  return Object.freeze({ ...input, callerIdentity: commerceCallerIdentity(input.siteId, input.actorKind, input.actorSubject, input.actorGeneration) });
}

export function commerceCallerIdentity(siteId: string, actorKind: CommerceCommandIdentity["actorKind"], actorSubject: string, actorGeneration: string): string {
  bounded(siteId, 256, "COMMAND_SITE_INVALID");
  bounded(actorSubject, 256, "COMMAND_ACTOR_INVALID");
  if (!/^[1-9][0-9]*$/u.test(actorGeneration)) throw new Error("COMMAND_ACTOR_GENERATION_INVALID");
  return `site:${siteId.length}:${siteId}|kind:${actorKind.length}:${actorKind}|actor:${actorSubject.length}:${actorSubject}|generation:${actorGeneration.length}:${actorGeneration}`;
}

export function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("SHA256_DIGEST_REQUIRED");
}

function bounded(value: string, max: number, code: string): void {
  if (value.length < 1 || value.length > max || [...value].some((character) => character.codePointAt(0)! < 32)) {
    throw new Error(code);
  }
}
