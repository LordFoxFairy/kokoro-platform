import type {
  ModelInventoryActivationReceipt,
  ModelInventoryImportReceipt,
  SiteModelPolicyChangeReceipt,
} from "./contracts/model-control-ports.js";
import type { CanonicalModelInventory } from "../domain/model-catalog.js";
import type { ProviderOperationalAvailability } from "../domain/provider-availability.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type {
  ModelOptionMaterializationReceipt,
  SiteReleaseModelCatalogPublishReceipt,
} from "./contracts/product-model-option-ports.js";

export interface ModelControlCommandSecurityFacts {
  readonly environment: string;
  readonly region: string;
  readonly callerIdentity: string;
  readonly callerBindingEpoch: string;
  readonly actorKind: "operator" | "workload";
  readonly actorSubjectId: string;
  readonly actorSubjectGeneration: string;
}

export function modelControlSecurityFacts(
  context: VerifiedRequestSecurityContext,
): ModelControlCommandSecurityFacts {
  if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
    throw new Error("MODEL_CONTROL_COMMAND_ACTOR_INVALID");
  return Object.freeze({
    environment: context.environment,
    region: context.region,
    callerIdentity: context.trustedCaller.workloadIdentityId,
    callerBindingEpoch: context.trustedCaller.bindingEpoch,
    actorKind: context.actor.kind,
    actorSubjectId: context.actor.subjectId,
    actorSubjectGeneration: context.actor.subjectGeneration,
  });
}

export type ModelControlCommandInput =
  | {
      readonly commandId: string;
      readonly idempotencyKey?: string;
      readonly requestDigest: string;
      readonly operation: "model.inventory.import";
      readonly security: ModelControlCommandSecurityFacts;
      readonly effect: {
        readonly inventoryDigest: string;
        readonly source: CanonicalModelInventory["source"];
        readonly providerAvailability: readonly ProviderOperationalAvailability[];
      };
    }
  | {
      readonly commandId: string;
      readonly idempotencyKey?: string;
      readonly requestDigest: string;
      readonly operation: "model.option.materialize";
      readonly security: ModelControlCommandSecurityFacts;
      readonly effect: {
        readonly sourceDigest: string;
        readonly inventoryDigest: string;
        readonly materializationDigest: string;
        readonly compilerVersion: "model-option-compiler.v2";
      };
    }
  | {
      readonly commandId: string;
      readonly idempotencyKey?: string;
      readonly requestDigest: string;
      readonly operation: "model.site-release-catalog.publish";
      readonly security: ModelControlCommandSecurityFacts;
      readonly effect: {
        readonly siteId: string;
        readonly siteReleaseRef: string;
        readonly inventoryDigest: string;
        readonly modelOptionCatalogRef: string;
        readonly catalogDigest: string;
      };
    }
  | {
      readonly commandId: string;
      readonly idempotencyKey?: string;
      readonly requestDigest: string;
      readonly operation: "model.inventory.activate";
      readonly security: ModelControlCommandSecurityFacts;
      readonly effect: {
        readonly targetDigest: string;
        readonly expectedPointerRevision: string;
      };
    }
  | {
      readonly commandId: string;
      readonly idempotencyKey?: string;
      readonly requestDigest: string;
      readonly operation: "model.site-policy.change";
      readonly security: ModelControlCommandSecurityFacts;
      readonly effect: {
        readonly siteId: string;
        readonly product: "chat" | "music" | "image" | "video";
        readonly policyDigest: string;
        readonly expectedRevision: string;
      };
    };

export interface ModelControlCommand<
  Input extends ModelControlCommandInput = ModelControlCommandInput,
> {
  readonly commandId: string;
  readonly operation: Input["operation"];
  readonly requestDigest: string;
  readonly input: Input & Readonly<{ idempotencyKey: string }>;
}

export type ModelControlCommandReceipt =
  | ModelInventoryImportReceipt
  | ModelInventoryActivationReceipt
  | SiteModelPolicyChangeReceipt
  | ModelOptionMaterializationReceipt
  | SiteReleaseModelCatalogPublishReceipt;

export function createModelControlCommand<const Input extends ModelControlCommandInput>(
  input: Input,
): ModelControlCommand<Input> {
  assertModelControlCommandId(input.commandId, "MODEL_CONTROL_COMMAND_ID_INVALID");
  if (!/^[0-9a-f]{64}$/u.test(input.requestDigest)) {
    throw new Error("MODEL_CONTROL_REQUEST_DIGEST_INVALID");
  }
  const idempotencyKey = input.idempotencyKey ?? input.commandId;
  if (idempotencyKey.length < 16 || idempotencyKey.length > 256 || containsControl(idempotencyKey)) {
    throw new Error("MODEL_CONTROL_IDEMPOTENCY_KEY_INVALID");
  }
  const canonicalInput = deepFreeze({
    ...input,
    idempotencyKey,
    security: {
      environment: text(input.security.environment),
      region: text(input.security.region),
      callerIdentity: text(input.security.callerIdentity),
      callerBindingEpoch: epoch(input.security.callerBindingEpoch),
      actorKind: input.security.actorKind,
      actorSubjectId: text(input.security.actorSubjectId),
      actorSubjectGeneration: epoch(input.security.actorSubjectGeneration),
    },
  }) as Input & Readonly<{ idempotencyKey: string }>;
  if (
    canonicalInput.security.actorKind !== "operator" &&
    canonicalInput.security.actorKind !== "workload"
  )
    throw new Error("MODEL_CONTROL_COMMAND_ACTOR_INVALID");
  return Object.freeze({
    commandId: canonicalInput.commandId,
    operation: canonicalInput.operation,
    requestDigest: canonicalInput.requestDigest,
    input: canonicalInput,
  });
}

export function assertModelControlCommandId(value: string, code: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
    throw new Error(code);
}

function epoch(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("MODEL_CONTROL_COMMAND_EPOCH_INVALID");
  return value;
}

function text(value: string): string {
  if (value.length < 1 || value.length > 512 || containsControl(value))
    throw new Error("MODEL_CONTROL_COMMAND_TEXT_INVALID");
  return value;
}

function containsControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 || codePoint === 127;
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
