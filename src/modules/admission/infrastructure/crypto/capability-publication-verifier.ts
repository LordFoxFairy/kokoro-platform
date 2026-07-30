import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

const reference = z.string().min(1).max(256).refine((value) => value.trim() === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const option = z.object({
  optionRef: reference,
  agent: reference,
  label: z.string().min(1).max(128),
}).strict();
const skill = z.object({
  optionRef: reference,
  label: z.string().min(1).max(128),
  name: reference,
  contentHash: digest,
  description: z.string().min(1).max(2_048),
  scope: reference,
  prerequisiteRef: reference.optional(),
}).strict();
const mcp = z.object({
  optionRef: reference,
  label: z.string().min(1).max(128),
  scope: reference,
  name: reference,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  configHash: digest,
  prerequisiteRef: reference.optional(),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  agentOptions: z.array(option).max(64),
  defaultAgentOptionRef: reference.optional(),
  tools: z.array(reference).max(256),
  skillOptions: z.array(skill).max(256),
  mcpOptions: z.array(mcp).max(256),
  subagents: z.array(reference).max(64),
}).strict();

type AgentOption = Readonly<z.infer<typeof option>>;
type SkillOption = Readonly<z.infer<typeof skill>>;
type McpOption = Readonly<z.infer<typeof mcp>>;

export type CapabilityCatalogSnapshot = Readonly<{
  schemaVersion: 1;
  agentOptions: readonly AgentOption[];
  defaultAgentOptionRef?: string;
  tools: readonly string[];
  skillOptions: readonly SkillOption[];
  mcpOptions: readonly McpOption[];
  subagents: readonly string[];
}>;

export interface CapabilityCatalogPublication {
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

/** Platform's independent implementation of the Hub snapshot digest contract. */
export function capabilitySnapshotDigest(value: CapabilityCatalogSnapshot): string {
  const parsed = snapshotSchema.parse(value);
  const snapshot: CapabilityCatalogSnapshot = {
    schemaVersion: 1,
    agentOptions: parsed.agentOptions,
    ...(parsed.defaultAgentOptionRef === undefined
      ? {} : { defaultAgentOptionRef: parsed.defaultAgentOptionRef }),
    tools: parsed.tools,
    skillOptions: parsed.skillOptions.map((item) => ({
      optionRef: item.optionRef,
      label: item.label,
      name: item.name,
      contentHash: item.contentHash,
      description: item.description,
      scope: item.scope,
      ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
    })),
    mcpOptions: parsed.mcpOptions.map((item) => ({
      optionRef: item.optionRef,
      label: item.label,
      scope: item.scope,
      name: item.name,
      revision: item.revision,
      configHash: item.configHash,
      ...(item.prerequisiteRef === undefined ? {} : { prerequisiteRef: item.prerequisiteRef }),
    })),
    subagents: parsed.subagents,
  };
  for (const values of [
    snapshot.agentOptions.map(({ optionRef }) => optionRef),
    snapshot.tools,
    snapshot.skillOptions.map(({ optionRef }) => optionRef),
    snapshot.mcpOptions.map(({ optionRef }) => optionRef),
    snapshot.subagents,
  ]) {
    if (new Set(values).size !== values.length) {
      throw new Error("CAPABILITY_PUBLICATION_SNAPSHOT_NOT_CANONICAL");
    }
  }
  if (snapshot.defaultAgentOptionRef !== undefined &&
      !snapshot.agentOptions.some(({ optionRef }) => optionRef === snapshot.defaultAgentOptionRef)) {
    throw new Error("CAPABILITY_PUBLICATION_SNAPSHOT_NOT_CANONICAL");
  }
  const canonical = canonicalSnapshot(snapshot);
  if (canonicalJson(snapshot) !== canonicalJson(canonical)) {
    throw new Error("CAPABILITY_PUBLICATION_SNAPSHOT_NOT_CANONICAL");
  }
  return sha256(canonicalJson(canonical));
}

export function capabilitySignaturePayloadDigest(
  value: Pick<CapabilityCatalogPublication,
    "siteId" | "siteReleaseRef" | "agentCatalogRef" | "snapshotDigest" | "signingKeyRef">,
): string {
  for (const item of [value.siteId, value.siteReleaseRef, value.signingKeyRef]) {
    if (!reference.safeParse(item).success) throw new Error("CAPABILITY_PUBLICATION_BINDING_INVALID");
  }
  if (!/^agent-catalog:sha256:[a-f0-9]{64}$/u.test(value.agentCatalogRef) ||
      !digest.safeParse(value.snapshotDigest).success) {
    throw new Error("CAPABILITY_PUBLICATION_BINDING_INVALID");
  }
  return sha256(canonicalJson({
    contractVersion: CONTRACT_VERSION,
    siteId: value.siteId,
    siteReleaseRef: value.siteReleaseRef,
    agentCatalogRef: value.agentCatalogRef,
    snapshotDigest: value.snapshotDigest,
    signingKeyRef: value.signingKeyRef,
  }));
}

export function createEd25519CapabilityPublicationVerifier(input: Readonly<{
  keys: ReadonlyMap<string, string>;
}>): (publication: CapabilityCatalogPublication) => CapabilityCatalogPublication {
  const keys = new Map<string, KeyObject>();
  for (const [keyRef, pem] of input.keys) {
    if (!reference.safeParse(keyRef).success || typeof pem !== "string" || !pem.includes("PUBLIC KEY")) {
      throw new Error("CAPABILITY_PUBLICATION_KEY_RING_INVALID");
    }
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519" || keys.has(keyRef)) {
      throw new Error("CAPABILITY_PUBLICATION_KEY_RING_INVALID");
    }
    keys.set(keyRef, key);
  }
  if (keys.size < 1 || keys.size > 32) throw new Error("CAPABILITY_PUBLICATION_KEY_RING_INVALID");

  return (publication) => {
    if (publication.signatureAlgorithm !== "ed25519-sha256-v1" ||
        !(publication.signature instanceof Uint8Array) || publication.signature.byteLength !== 64 ||
        !Number.isFinite(Date.parse(publication.frozenAt))) {
      throw new Error("CAPABILITY_PUBLICATION_SIGNATURE_INVALID");
    }
    const key = keys.get(publication.signingKeyRef);
    if (key === undefined) throw new Error("CAPABILITY_PUBLICATION_SIGNING_KEY_UNKNOWN");
    const snapshotDigest = capabilitySnapshotDigest(publication.snapshot);
    if (snapshotDigest !== publication.snapshotDigest) {
      throw new Error("CAPABILITY_PUBLICATION_SNAPSHOT_DIGEST_MISMATCH");
    }
    if (publication.agentCatalogRef !== `agent-catalog:sha256:${snapshotDigest}`) {
      throw new Error("CAPABILITY_PUBLICATION_CATALOG_REF_MISMATCH");
    }
    const payloadDigest = capabilitySignaturePayloadDigest(publication);
    if (payloadDigest !== publication.signaturePayloadDigest) {
      throw new Error("CAPABILITY_PUBLICATION_SIGNATURE_PAYLOAD_MISMATCH");
    }
    if (!verify(null, Buffer.from(payloadDigest, "hex"), key, publication.signature)) {
      throw new Error("CAPABILITY_PUBLICATION_SIGNATURE_INVALID");
    }
    return publication;
  };
}

function canonicalSnapshot(value: CapabilityCatalogSnapshot): CapabilityCatalogSnapshot {
  const byRef = <Value extends { optionRef: string }>(items: readonly Value[]) =>
    [...items].sort((left, right) => left.optionRef.localeCompare(right.optionRef));
  return {
    schemaVersion: 1,
    agentOptions: byRef(value.agentOptions),
    ...(value.defaultAgentOptionRef === undefined ? {} : { defaultAgentOptionRef: value.defaultAgentOptionRef }),
    tools: [...value.tools].sort(),
    skillOptions: byRef(value.skillOptions),
    mcpOptions: byRef(value.mcpOptions),
    subagents: [...value.subagents].sort(),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
