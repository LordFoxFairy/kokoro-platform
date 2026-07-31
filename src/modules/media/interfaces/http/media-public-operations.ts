import type {
  PlatformPublicOperationExecution,
  RegisteredPlatformPublicOperation,
} from "../../../../interfaces/http/platform-public-operation-registry.js";
import { definePlatformPublicOperation } from
  "../../../../interfaces/http/platform-public-operation-registry.js";
import type { PlatformPublicOperationResponseMap } from
  "../../../../interfaces/http/generated/platform-public/operations.gen.js";

export const MEDIA_PUBLIC_OPERATION_IDS = Object.freeze([
  "listMediaOperationDefinitions",
  "getMediaOperationDefinition",
  "listMediaOperationModelOptions",
  "quoteMediaOperation",
  "submitMediaOperation",
  "listMediaOperations",
  "getMediaOperation",
  "cancelMediaOperation",
  "recoverMediaOperationCommand",
] as const);

export type MediaPublicOperationId = (typeof MEDIA_PUBLIC_OPERATION_IDS)[number];

type Handler<Id extends MediaPublicOperationId> = (
  input: PlatformPublicOperationExecution<Id>,
) => Promise<PlatformPublicOperationResponseMap[Id]>;

/** Complete owner port: composition cannot activate a partial Direct Studio surface. */
export type MediaPublicOperationOwner = Readonly<{
  [Id in MediaPublicOperationId]: Handler<Id>;
}>;

export function createMediaPublicOperations(
  owner: MediaPublicOperationOwner,
): readonly RegisteredPlatformPublicOperation[] {
  const targetProjectRef = ({ path }: Readonly<{ path: { projectRef: string } }>) => path.projectRef;
  return Object.freeze([
    definePlatformPublicOperation({ operationId: "listMediaOperationDefinitions", targetProjectRef,
      execute: (input) => owner.listMediaOperationDefinitions(input) }),
    definePlatformPublicOperation({ operationId: "getMediaOperationDefinition", targetProjectRef,
      execute: (input) => owner.getMediaOperationDefinition(input) }),
    definePlatformPublicOperation({ operationId: "listMediaOperationModelOptions", targetProjectRef,
      execute: (input) => owner.listMediaOperationModelOptions(input) }),
    definePlatformPublicOperation({ operationId: "quoteMediaOperation", targetProjectRef,
      execute: (input) => owner.quoteMediaOperation(input) }),
    definePlatformPublicOperation({ operationId: "submitMediaOperation", targetProjectRef,
      successStatus: mediaCommandStatus, execute: (input) => owner.submitMediaOperation(input) }),
    definePlatformPublicOperation({ operationId: "listMediaOperations", targetProjectRef,
      execute: (input) => owner.listMediaOperations(input) }),
    definePlatformPublicOperation({ operationId: "getMediaOperation", targetProjectRef,
      execute: (input) => owner.getMediaOperation(input) }),
    definePlatformPublicOperation({ operationId: "cancelMediaOperation", targetProjectRef,
      successStatus: mediaCommandStatus, execute: (input) => owner.cancelMediaOperation(input) }),
    definePlatformPublicOperation({ operationId: "recoverMediaOperationCommand", targetProjectRef,
      execute: (input) => owner.recoverMediaOperationCommand(input) }),
  ]);
}

function mediaCommandStatus(result: unknown): 200 | 201 | 202 {
  if (typeof result !== "object" || result === null || !("receipt" in result)) {
    throw new Error("MEDIA_PUBLIC_COMMAND_RESPONSE_INVALID");
  }
  const receipt = (result as { receipt?: unknown }).receipt;
  if (typeof receipt !== "object" || receipt === null || !("receiptKind" in receipt)) {
    throw new Error("MEDIA_PUBLIC_COMMAND_RESPONSE_INVALID");
  }
  const kind = (receipt as { receiptKind?: unknown }).receiptKind;
  if (kind === "submit_outcome_unknown" || kind === "cancel_outcome_unknown") return 202;
  return typeof kind === "string" && kind.startsWith("submit_") ? 201 : 200;
}
