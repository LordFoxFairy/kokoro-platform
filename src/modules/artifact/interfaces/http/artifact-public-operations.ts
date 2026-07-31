import type {
  PlatformPublicOperationExecution,
  RegisteredPlatformPublicOperation,
} from "../../../../interfaces/http/platform-public-operation-registry.js";
import { definePlatformPublicOperation } from
  "../../../../interfaces/http/platform-public-operation-registry.js";
import type { PlatformPublicOperationResponseMap } from
  "../../../../interfaces/http/generated/platform-public/operations.gen.js";
import type { ArtifactDeliveryAuthorizationInput } from
  "../../../../interfaces/http/generated/platform-public/types.gen.js";
import type { ArtifactPublicOwnerService } from "../../application/artifact-public-owner.js";

export const ARTIFACT_PUBLIC_OPERATION_IDS = Object.freeze([
  "listArtifacts",
  "getArtifact",
  "listArtifactVersions",
  "getArtifactVersion",
  "issueArtifactDeliveryAuthorization",
  "revokeArtifactDeliveryAuthorization",
] as const);

export type ArtifactPublicOperationId = (typeof ARTIFACT_PUBLIC_OPERATION_IDS)[number];

type Handler<Id extends ArtifactPublicOperationId> = (
  input: PlatformPublicOperationExecution<Id>,
) => Promise<PlatformPublicOperationResponseMap[Id]>;

/**
 * Complete JSON control-plane owner. Binary redemption is deliberately absent
 * and is mounted only by the Artifact data-plane process.
 */
export type ArtifactPublicOperationOwner = Readonly<{
  [Id in ArtifactPublicOperationId]: Handler<Id>;
}>;

export function createArtifactPublicOperations(
  owner: ArtifactPublicOperationOwner,
): readonly RegisteredPlatformPublicOperation[] {
  const targetProjectRef = ({ path }: Readonly<{ path: { projectRef: string } }>) => path.projectRef;
  return Object.freeze([
    definePlatformPublicOperation({ operationId: "listArtifacts", targetProjectRef,
      execute: (input) => owner.listArtifacts(input) }),
    definePlatformPublicOperation({ operationId: "getArtifact", targetProjectRef,
      execute: (input) => owner.getArtifact(input) }),
    definePlatformPublicOperation({ operationId: "listArtifactVersions", targetProjectRef,
      execute: (input) => owner.listArtifactVersions(input) }),
    definePlatformPublicOperation({ operationId: "getArtifactVersion", targetProjectRef,
      execute: (input) => owner.getArtifactVersion(input) }),
    definePlatformPublicOperation({ operationId: "issueArtifactDeliveryAuthorization", targetProjectRef,
      successStatus: () => 201, execute: (input) => owner.issueArtifactDeliveryAuthorization(input) }),
    definePlatformPublicOperation({ operationId: "revokeArtifactDeliveryAuthorization", targetProjectRef,
      execute: (input) => owner.revokeArtifactDeliveryAuthorization(input) }),
  ]);
}

/** Transport adapter for the application owner used by the production public API composition. */
export function createArtifactPublicApplicationOperations(
  application: Pick<ArtifactPublicOwnerService,
    "listArtifacts" | "getArtifact" | "listArtifactVersions" | "getArtifactVersion" |
    "issueDeliveryAuthorization" | "revokeDeliveryAuthorization">,
): readonly RegisteredPlatformPublicOperation[] {
  return createArtifactPublicOperations({
    listArtifacts: (input) => application.listArtifacts({
      context: input.context,
      ...(input.query?.cursor === undefined ? {} : { cursor: input.query.cursor }),
      ...(input.query?.limit === undefined ? {} : { limit: input.query.limit }),
    }),
    getArtifact: (input) => application.getArtifact({
      context: input.context,
      artifactRef: input.path.artifactRef,
    }),
    listArtifactVersions: (input) => application.listArtifactVersions({
      context: input.context,
      artifactRef: input.path.artifactRef,
      ...(input.query?.cursor === undefined ? {} : { cursor: input.query.cursor }),
      ...(input.query?.limit === undefined ? {} : { limit: input.query.limit }),
    }),
    getArtifactVersion: (input) => application.getArtifactVersion({
      context: input.context,
      artifactRef: input.path.artifactRef,
      artifactVersionRef: input.path.artifactVersionRef,
    }),
    issueArtifactDeliveryAuthorization: (input) => application.issueDeliveryAuthorization({
      context: input.context,
      artifactRef: input.path.artifactRef,
      artifactVersionRef: input.path.artifactVersionRef,
      request: deliveryRequest(input.body),
    }),
    revokeArtifactDeliveryAuthorization: (input) => application.revokeDeliveryAuthorization({
      context: input.context,
      authorizationRef: input.path.authorizationRef,
      ...(input.body.reason === undefined ? {} : { reason: input.body.reason }),
    }),
  });
}

function deliveryRequest(
  input: PlatformPublicOperationExecution<"issueArtifactDeliveryAuthorization">["body"],
): ArtifactDeliveryAuthorizationInput {
  if (input.purpose === "preview") {
    return Object.freeze({ purpose: "preview", viewportClass: input.viewportClass });
  }
  if (input.purpose === "download") {
    return Object.freeze({ purpose: "download",
      ...(input.suggestedFileName === undefined ? {} : { suggestedFileName: input.suggestedFileName }) });
  }
  return Object.freeze({ purpose: "export", exportIntentRef: input.exportIntentRef });
}
