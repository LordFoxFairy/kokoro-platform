import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";

const reference = z.string().min(1).max(256).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  agentOptions: z.array(z.object({
    optionRef: reference,
    agent: reference,
    label: z.string().min(1).max(128),
  }).strict()).max(64),
  defaultAgentOptionRef: reference.optional(),
  tools: z.array(reference).max(256),
  skillOptions: z.array(z.object({
    optionRef: reference,
    label: z.string().min(1).max(128),
    name: reference,
    contentHash: digest,
    description: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 2_048),
    scope: reference,
    prerequisiteRef: reference.optional(),
  }).strict()).max(256),
  mcpOptions: z.array(z.object({
    optionRef: reference,
    label: z.string().min(1).max(128),
    scope: reference,
    name: reference,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    configHash: digest,
    prerequisiteRef: reference.optional(),
  }).strict()).max(256),
  subagents: z.array(reference).max(64),
}).strict();

type DeepReadonly<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value;

export type CapabilityCatalogSnapshot = DeepReadonly<z.infer<typeof snapshotSchema>>;

export interface FrozenCapabilityCatalogPublication {
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly agentCatalogRef: string;
  readonly snapshotDigest: string;
  readonly snapshot: CapabilityCatalogSnapshot;
  readonly frozenAt: string;
  readonly signingKeyRef: string;
  readonly signatureAlgorithm: "ed25519-sha256-v1";
  readonly signaturePayloadDigest: string;
  readonly signature: Uint8Array;
}

const CONTRACT_VERSION = "kokoro.platform.capability.v1";

export function canonicalizeCapabilityCatalogSnapshot(value: unknown): CapabilityCatalogSnapshot {
  const parsed = snapshotSchema.parse(value);
  assertUnique(parsed.agentOptions.map(({ optionRef }) => optionRef));
  assertUnique(parsed.tools);
  assertUnique(parsed.skillOptions.map(({ optionRef }) => optionRef));
  assertUnique(parsed.mcpOptions.map(({ optionRef }) => optionRef));
  assertUnique(parsed.subagents);
  if (parsed.defaultAgentOptionRef !== undefined &&
      !parsed.agentOptions.some(({ optionRef }) => optionRef === parsed.defaultAgentOptionRef)) {
    throw new Error("HUB_CAPABILITY_CATALOG_DEFAULT_AGENT_INVALID");
  }
  const byRef = <Value extends { optionRef: string }>(items: readonly Value[]) =>
    [...items].sort((left, right) => compare(left.optionRef, right.optionRef));
  return Object.freeze({
    schemaVersion: 1 as const,
    agentOptions: Object.freeze(byRef(parsed.agentOptions).map((item) => Object.freeze(item))),
    ...(parsed.defaultAgentOptionRef === undefined
      ? {} : { defaultAgentOptionRef: parsed.defaultAgentOptionRef }),
    tools: Object.freeze([...parsed.tools].sort(compare)),
    skillOptions: Object.freeze(byRef(parsed.skillOptions).map((item) => Object.freeze(item))),
    mcpOptions: Object.freeze(byRef(parsed.mcpOptions).map((item) => Object.freeze(item))),
    subagents: Object.freeze([...parsed.subagents].sort(compare)),
  });
}

export function capabilityCatalogSnapshotDigest(snapshot: CapabilityCatalogSnapshot): string {
  return sha256(canonicalJson(canonicalizeCapabilityCatalogSnapshot(snapshot)));
}

export function capabilityCatalogSignaturePayloadDigest(input: Readonly<{
  siteId: string;
  siteReleaseRef: string;
  agentCatalogRef: string;
  snapshotDigest: string;
  signingKeyRef: string;
}>): string {
  for (const value of [input.siteId, input.siteReleaseRef, input.signingKeyRef]) {
    if (!reference.safeParse(value).success) throw new Error("HUB_CAPABILITY_CATALOG_BINDING_INVALID");
  }
  if (!/^agent-catalog:sha256:[a-f0-9]{64}$/u.test(input.agentCatalogRef) ||
      !digest.safeParse(input.snapshotDigest).success) {
    throw new Error("HUB_CAPABILITY_CATALOG_BINDING_INVALID");
  }
  return sha256(canonicalJson({
    contractVersion: CONTRACT_VERSION,
    siteId: input.siteId,
    siteReleaseRef: input.siteReleaseRef,
    agentCatalogRef: input.agentCatalogRef,
    snapshotDigest: input.snapshotDigest,
    signingKeyRef: input.signingKeyRef,
  }));
}

export function createEd25519CapabilityCatalogSigner(input: Readonly<{
  signingKeyRef: string;
  privateKeyPem: string;
}>): Readonly<{
  signingKeyRef: string;
  sign(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    snapshot: CapabilityCatalogSnapshot;
    frozenAt: string;
  }>): FrozenCapabilityCatalogPublication;
}> {
  if (!reference.safeParse(input.signingKeyRef).success ||
      !input.privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("HUB_CAPABILITY_CATALOG_SIGNING_KEY_INVALID");
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new Error("HUB_CAPABILITY_CATALOG_SIGNING_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("HUB_CAPABILITY_CATALOG_SIGNING_KEY_INVALID");
  }
  return Object.freeze({
    signingKeyRef: input.signingKeyRef,
    sign(value) {
      const snapshot = canonicalizeCapabilityCatalogSnapshot(value.snapshot);
      const snapshotDigest = capabilityCatalogSnapshotDigest(snapshot);
      const agentCatalogRef = `agent-catalog:sha256:${snapshotDigest}`;
      const signaturePayloadDigest = capabilityCatalogSignaturePayloadDigest({
        siteId: value.siteId,
        siteReleaseRef: value.siteReleaseRef,
        agentCatalogRef,
        snapshotDigest,
        signingKeyRef: input.signingKeyRef,
      });
      const frozen = Date.parse(value.frozenAt);
      if (!Number.isFinite(frozen) || new Date(frozen).toISOString() !== value.frozenAt) {
        throw new Error("HUB_CAPABILITY_CATALOG_FROZEN_AT_INVALID");
      }
      return Object.freeze({
        siteId: value.siteId,
        siteReleaseRef: value.siteReleaseRef,
        agentCatalogRef,
        snapshotDigest,
        snapshot,
        frozenAt: value.frozenAt,
        signingKeyRef: input.signingKeyRef,
        signatureAlgorithm: "ed25519-sha256-v1" as const,
        signaturePayloadDigest,
        signature: new Uint8Array(sign(null, Buffer.from(signaturePayloadDigest, "hex"), key)),
      });
    },
  });
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("HUB_CAPABILITY_CATALOG_DUPLICATE_REFERENCE");
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
