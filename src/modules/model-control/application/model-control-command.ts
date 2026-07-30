import { createHash } from "node:crypto";
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

export interface ModelControlCommittedEvent {
  readonly eventId: string;
  readonly owner: "model-control";
  readonly eventType:
    | "model.inventory.materialized.v1"
    | "model.inventory.activated.v1"
    | "model.site-policy.changed.v1"
    | "model.option-revisions.materialized.v1"
    | "model.site-release-catalog.published.v1";
  readonly aggregateId: string;
  readonly payload: {
    readonly schemaVersion: 1;
    readonly eventType: ModelControlCommittedEvent["eventType"];
    readonly commandId: string;
    readonly requestDigest: string;
    readonly receipt: Omit<ModelControlCommandReceipt, "replayed">;
  };
  readonly payloadDigest: string;
  readonly receipt: Omit<ModelControlCommandReceipt, "replayed">;
}

export function createModelControlCommand<const Input extends ModelControlCommandInput>(
  input: Input,
): ModelControlCommand<Input> {
  uuid(input.commandId, "MODEL_CONTROL_COMMAND_ID_INVALID");
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
    requestDigest: sha256(
      stableJson({
        schemaVersion: 1,
        operation: canonicalInput.operation,
        security: canonicalInput.security,
        effect: canonicalInput.effect,
      }),
    ),
    input: canonicalInput,
  });
}

export function modelControlEventFor(
  command: ModelControlCommand,
  receipt: ModelControlCommandReceipt,
): ModelControlCommittedEvent {
  const { replayed: _replayed, ...stableReceipt } = receipt;
  let eventType: ModelControlCommittedEvent["eventType"];
  let aggregateId: string;
  if (command.operation === "model.inventory.import") {
    eventType = "model.inventory.materialized.v1";
    aggregateId = (stableReceipt as Omit<ModelInventoryImportReceipt, "replayed">).digest;
  } else if (command.operation === "model.inventory.activate") {
    eventType = "model.inventory.activated.v1";
    aggregateId = (stableReceipt as Omit<ModelInventoryActivationReceipt, "replayed">).targetDigest;
  } else if (command.operation === "model.site-policy.change") {
    eventType = "model.site-policy.changed.v1";
    const effect = command.input.effect as Extract<
      ModelControlCommandInput,
      { operation: "model.site-policy.change" }
    >["effect"];
    aggregateId = `${effect.siteId}:${effect.product}`;
  } else if (command.operation === "model.option.materialize") {
    eventType = "model.option-revisions.materialized.v1";
    aggregateId = (
      stableReceipt as Omit<ModelOptionMaterializationReceipt, "replayed">
    ).materializationDigest;
  } else {
    eventType = "model.site-release-catalog.published.v1";
    aggregateId = (
      stableReceipt as Omit<SiteReleaseModelCatalogPublishReceipt, "replayed">
    ).modelOptionCatalogRef;
  }
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    eventType,
    commandId: command.commandId,
    requestDigest: command.requestDigest,
    receipt: stableReceipt,
  });
  return deepFreeze({
    eventId: deterministicUuid(`${eventType}:${command.commandId}:${command.requestDigest}`),
    owner: "model-control" as const,
    eventType,
    aggregateId,
    payload,
    payloadDigest: sha256(stableJson(payload)),
    receipt: stableReceipt,
  });
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuid(value: string, code: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
