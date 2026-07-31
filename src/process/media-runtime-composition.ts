import { randomUUID } from "node:crypto";
import type { HandlerContext } from "@connectrpc/connect";
import {
  EnvelopeOperationInputProtector,
  ImageOperationSubmissionService,
  PostgresAgentImageAccessOwner,
  PostgresMediaImageOperationRepository,
  PostgresMediaRuntimeDatabase,
  PostgresMediaRuntimeQueryRepository,
  createMediaRuntimeConnectService,
  type MediaImageCreditAllocationPort,
  type MediaRuntimeConnectService,
} from "../modules/media/index.js";

export interface MediaRuntimeApplicationComposition {
  readonly application: ImageOperationSubmissionService;
  readonly service: MediaRuntimeConnectService;
  readonly query: PostgresMediaRuntimeQueryRepository;
}

/**
 * Production Agent Media factory. Every stateful adapter is PostgreSQL-backed;
 * Credit remains an explicit owner port so it can be local or RPC without GA
 * learning financial internals.
 */
export function createMediaRuntimeApplicationComposition(input: Readonly<{
  database: PostgresMediaRuntimeDatabase;
  credit: MediaImageCreditAllocationPort;
  inputEncryptionKey: Readonly<{ keyRevisionRef: string; key: Uint8Array }>;
  ownerDigestKey: Uint8Array;
  mediaAccessKey: Uint8Array;
  outputHandleKey: Uint8Array;
  agentCallerIdentity: string;
  caller: Readonly<{ resolve(context: HandlerContext): Readonly<{ identity: string }> }>;
  clock?: () => Date;
}>): MediaRuntimeApplicationComposition {
  for (const key of [input.ownerDigestKey, input.mediaAccessKey, input.outputHandleKey]) {
    if (key.byteLength !== 32) throw new Error("MEDIA_RUNTIME_KEY_INVALID");
  }
  const repository = new PostgresMediaImageOperationRepository();
  const query = new PostgresMediaRuntimeQueryRepository({ database: input.database,
    handleKey: input.outputHandleKey });
  const application = new ImageOperationSubmissionService({
    admission: { resolveDirectStudio: async () => {
      throw new Error("MEDIA_DIRECT_STUDIO_ADMISSION_NOT_AVAILABLE_ON_AGENT_RUNTIME");
    } },
    agentAccess: new PostgresAgentImageAccessOwner({ database: input.database,
      mediaAccessKey: input.mediaAccessKey }),
    credit: input.credit,
    repository,
    inputProtector: new EnvelopeOperationInputProtector({ activeKey: input.inputEncryptionKey }),
    ownerDigestKey: input.ownerDigestKey,
    unitOfWork: input.database,
    reference: (kind) => `${kind}:${randomUUID()}`,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return Object.freeze({ application, query,
    service: createMediaRuntimeConnectService({ application, query,
      agentCallerIdentity: input.agentCallerIdentity, caller: input.caller,
      ...(input.clock === undefined ? {} : { clock: input.clock }) }) });
}
