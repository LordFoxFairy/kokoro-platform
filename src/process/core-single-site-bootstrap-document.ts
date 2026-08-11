import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";

const MAXIMUM_DOCUMENT_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STABLE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const PRIVATE_PATH = z.string().refine(isAbsolute);
const digest = z.string().regex(SHA256);
const stableRef = z.string().regex(STABLE_REF);

export const CORE_SINGLE_SITE_SURFACES = Object.freeze(["account", "chat", "redemption"] as const);

const documentSchema = z.object({
  version: z.literal(1),
  bootstrapId: z.string().regex(UUID),
  environment: z.enum(["staging", "production"]),
  region: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
  makerSubjectRef: stableRef,
  checkerSubjectRef: stableRef,
  site: z.object({
    siteId: stableRef,
    siteKey: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
    siteReleaseRef: stableRef,
    siteProjectBindingRef: stableRef,
    workloadIdentityId: z.string().regex(/^spiffe:\/\/[A-Za-z0-9._:/-]{3,240}$/u),
    workloadBindingEpoch: z.string().regex(POSITIVE_INTEGER),
    providerNamespace: z.string().regex(/^[a-z][a-z0-9.-]{1,63}$/u),
    providerProjectRef: stableRef,
    metadataEndpoint: z.string().superRefine((value, context) => safeInternalHttps(value, context)),
    webArtifactDigest: digest,
    releaseManifestDigest: digest,
    certificationDigest: digest,
    signedContractFloor: z.object({ ref: stableRef, revision: z.string().regex(POSITIVE_INTEGER), digest }).strict(),
    audience: stableRef,
    sessionContractRevision: stableRef,
  }).strict(),
  model: z.object({
    provider: z.literal("direct"),
    providerKey: stableRef,
    modelKey: stableRef,
    modelOptionKey: stableRef,
    endpoint: z.string().superRefine((value, context) => safeInternalHttps(value, context)),
    inventoryRef: stableRef,
    inventoryRevision: z.string().regex(POSITIVE_INTEGER),
    optionRevisionRef: stableRef,
    catalogRef: stableRef,
  }).strict(),
  rating: z.object({
    policyRevisionRef: stableRef,
    unit: stableRef,
    inputTokenAmount: z.string().regex(POSITIVE_INTEGER),
    outputTokenAmount: z.string().regex(POSITIVE_INTEGER),
  }).strict(),
  redemption: z.object({
    creditProgramRevisionRef: stableRef,
    productVersionRef: stableRef,
    fulfillmentProgramRevisionRef: stableRef,
    programRevisionRef: stableRef,
    batchRef: z.string().regex(UUID),
    amount: z.string().regex(POSITIVE_INTEGER),
    liabilityMerchantAccountRef: stableRef,
    entropyKeyFile: PRIVATE_PATH,
  }).strict(),
  identity: z.object({
    email: z.string().email().max(320),
    passwordFile: PRIVATE_PATH,
    accountRef: stableRef,
    subjectRef: stableRef,
    workspaceRef: stableRef,
    projectRef: stableRef,
    billingAccountRef: stableRef,
    executionSpaceRef: stableRef,
    executionNamespace: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u),
  }).strict(),
  externalEmptyAgentCatalogRef: z.string().regex(/^agent-catalog:sha256:[a-f0-9]{64}$/u),
}).strict().superRefine((value, context) => {
  if (value.makerSubjectRef === value.checkerSubjectRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "maker_checker_distinct" });
  }
});

export type CoreSingleSiteBootstrapDocument = Readonly<z.infer<typeof documentSchema>>;
export type CoreBootstrapSecretDigests = Readonly<{ password: string; redemptionEntropy: string }>;

export async function loadCoreSingleSiteBootstrapDocument(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CoreSingleSiteBootstrapDocument> {
  const source = await readPrivateFile(path, MAXIMUM_DOCUMENT_BYTES, "document");
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DOCUMENT_INVALID");
  }
  const result = documentSchema.safeParse(raw);
  if (!result.success) throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_DOCUMENT_INVALID");
  const expected = environment.KOKORO_ENVIRONMENT;
  if (expected !== undefined && expected !== result.data.environment) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ENVIRONMENT_MISMATCH");
  }
  await Promise.all([
    readPrivateFile(result.data.identity.passwordFile, 4096, "secret"),
    readPrivateFile(result.data.redemption.entropyKeyFile, 4096, "secret"),
  ]);
  return deepFreeze(result.data);
}

export function coreBootstrapConfigDigest(
  document: CoreSingleSiteBootstrapDocument,
  secretDigests: CoreBootstrapSecretDigests,
): string {
  if (!SHA256.test(secretDigests.password) || !SHA256.test(secretDigests.redemptionEntropy)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_SECRET_DIGEST_INVALID");
  }
  return createHash("sha256")
    .update("kokoro.core-single-site-bootstrap.config.v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson({ document, secretDigests }), "utf8")
    .digest("hex");
}

export function coreBootstrapUuid(bootstrapId: string, step: string): string {
  assertRecipeInput(bootstrapId, step);
  const bytes = createHash("sha256")
    .update("kokoro.core-single-site-bootstrap.uuid.v1", "utf8")
    .update("\0", "utf8")
    .update(bootstrapId, "utf8")
    .update("\0", "utf8")
    .update(step, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function coreBootstrapIdempotencyKey(bootstrapId: string, step: string): string {
  assertRecipeInput(bootstrapId, step);
  return `core-bootstrap:${bootstrapId}:${step}`;
}

export async function coreBootstrapSecretDigests(
  document: CoreSingleSiteBootstrapDocument,
): Promise<CoreBootstrapSecretDigests> {
  const [password, entropy] = await Promise.all([
    readPrivateFile(document.identity.passwordFile, 4096, "secret"),
    readPrivateFile(document.redemption.entropyKeyFile, 4096, "secret"),
  ]);
  return Object.freeze({
    password: createHash("sha256").update(password, "utf8").digest("hex"),
    redemptionEntropy: createHash("sha256").update(entropy, "utf8").digest("hex"),
  });
}

async function readPrivateFile(path: string, maximum: number, kind: "document" | "secret"): Promise<string> {
  const invalid = kind === "document" ? "CORE_SINGLE_SITE_BOOTSTRAP_FILE_INVALID" :
    "CORE_SINGLE_SITE_BOOTSTRAP_SECRET_FILE_INVALID";
  const permissions = kind === "document" ? "CORE_SINGLE_SITE_BOOTSTRAP_FILE_PERMISSIONS_INVALID" :
    "CORE_SINGLE_SITE_BOOTSTRAP_SECRET_FILE_PERMISSIONS_INVALID";
  if (!isAbsolute(path)) throw new Error(invalid);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error(invalid);
    if ((stat.mode & 0o0777) !== 0o600) throw new Error(permissions);
    const bytes = Buffer.alloc(stat.size);
    const result = await handle.read(bytes, 0, stat.size, 0);
    if (result.bytesRead !== stat.size) throw new Error(invalid);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CORE_SINGLE_SITE_BOOTSTRAP_")) throw error;
    throw new Error(invalid);
  } finally {
    await handle?.close();
  }
}

function safeInternalHttps(value: string, context: z.RefinementCtx): void {
  let url: URL;
  try { url = new URL(value); } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint" });
    return;
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || isIP(url.hostname) !== 0 ||
    url.hostname === "localhost" || !url.hostname.includes(".") || url.pathname.includes("..")
  ) context.addIssue({ code: z.ZodIssueCode.custom, message: "endpoint" });
}

function assertRecipeInput(bootstrapId: string, step: string): void {
  if (!UUID.test(bootstrapId) || !/^[a-z][a-z0-9.-]{2,127}$/u.test(step)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_RECIPE_INVALID");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
