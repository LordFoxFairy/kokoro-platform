import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { normalizeIdentityEmail } from "../modules/identity/domain/identity-email.js";
import { IDENTITY_LAUNCH_OPERATION_IDS } from
  "../modules/identity/interfaces/http/identity-public-operations.js";
import { AUTHORIZATION_PUBLIC_OPERATION_IDS } from
  "../modules/authorization/interfaces/http/authorization-public-operations.js";
import { COMMERCE_PUBLIC_OPERATION_IDS } from
  "../modules/commerce/interfaces/http/commerce-public-operations.js";
import {
  canonicalCertificationPayload,
  Ed25519SiteReleaseCertificationAuthority,
  parseSiteReleaseCertificationKeys,
} from "../modules/site/infrastructure/crypto/site-release-certification-authority.js";
import { assertFixedSiteProviderBinding } from
  "../modules/site/infrastructure/rpc/site-provider-registry-config.js";
import { createSessionAuthorizationEventSigner } from
  "../modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import type { RequestSecurityContext } from
  "../shared/security-context/request-security-context.js";
import {
  coreBootstrapAdminAttestationPayload,
  parseCoreBootstrapAdminAttestationBundle,
  type CoreBootstrapAdminAttestationBundle,
} from "./core-single-site-bootstrap-attestation.js";
import {
  CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
  CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_REF,
  CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
  coreSingleSiteBootstrapAttestationAllowedOperations,
  coreSingleSiteBootstrapAttestationTarget,
  createCoreSingleSiteBootstrapRecipe,
  deriveCoreSingleSiteBootstrapModelArtifacts,
  prepareCoreSingleSiteBootstrapExecution,
} from "./core-single-site-bootstrap-composition.js";
import {
  coreBootstrapConfigDigest,
  coreBootstrapUuid,
  parseCoreSingleSiteBootstrapDocument,
  type CoreSingleSiteBootstrapDocument,
} from "./core-single-site-bootstrap-document.js";
import {
  loadAuthorizationEventKeyRing,
  loadIdentityAuditDigester,
  loadIdentityPasswordHasher,
  loadRedemptionSecretCodec,
} from "./platform-public-composition.js";
import { loadAuthorizationVerificationKeys } from "./session-authorization-composition.js";
import { readBoundedPrivateFile } from "./secret-files.js";

const ARGUMENTS = Object.freeze([
  "operator-config",
  "web-report",
  "deployment-facts",
  "state-directory",
] as const);
const SHA256 = /^[a-f0-9]{64}$/u;
const SITE_LIFECYCLE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const MODEL_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const EXACT_OCI_IMAGE = /^(?<repository>[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)@sha256:(?<digest>[a-f0-9]{64})$/u;
const DNS_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
export const CORE_SINGLE_SITE_METADATA_ENDPOINT =
  "http://kokoro-site-release.internal:3000/api/release/metadata";
const CONTAINER_OWNER_PASSWORD = "/run/secrets/kokoro/owner-password";
const CONTAINER_REDEMPTION_ENTROPY = "/run/secrets/kokoro/redemption-entropy";
const ADMIN_AUDIENCE = "platform-admin";
const IMMUTABLE_AUTHORIZATION_KEY_NOT_AFTER = "9999-12-31T23:59:59.999Z";
const FEATURE_OFF_IDENTITY_OPERATION_IDS: ReadonlySet<string> = new Set([
  "beginRegistration",
  "resendEmailVerification",
  "completeEmailVerification",
]);
const CORE_SINGLE_SITE_PUBLIC_OPERATION_IDS = Object.freeze([
  ...new Set<string>([
    ...AUTHORIZATION_PUBLIC_OPERATION_IDS,
    ...IDENTITY_LAUNCH_OPERATION_IDS.filter((operationId) =>
      !FEATURE_OFF_IDENTITY_OPERATION_IDS.has(operationId)),
    ...COMMERCE_PUBLIC_OPERATION_IDS,
  ]),
].sort((left, right) => left.localeCompare(right, "en")));
const PRIVATE_PATHS = Object.freeze({
  bootstrapDocument: "bootstrap/core-single-site.json",
  makerAttestation: "bootstrap/authorization/maker-attestation.json",
  makerPublicKey: "bootstrap/authorization/maker-public-key.pem",
  checkerAttestation: "bootstrap/authorization/checker-attestation.json",
  checkerPublicKey: "bootstrap/authorization/checker-public-key.pem",
  siteReleaseCertificationKeys:
    "secrets/platform-admin/site-release-certification-keys.json",
  ownerPassword: "secrets/platform-core-bootstrap/owner-password",
  redemptionEntropy: "secrets/platform-core-bootstrap/redemption-entropy",
  siteProviderRegistry: "secrets/platform-core-bootstrap/site-providers.json",
  authorizationEventKeys: "secrets/platform-api/authorization-event-keys.json",
  authorizationEventVerificationKeys:
    "secrets/platform-authorization/authorization-event-public.json",
  commerceRedemptionKeys: "secrets/platform-api/commerce-redemption-keys.json",
  identityPasswordPeppers: "secrets/platform-api/identity-password-peppers.json",
  identityAuditKey: "secrets/platform-api/identity-audit.key",
  privateArtifactsManifest: "private-artifacts.json",
  outputDirectory: "output",
});
const PREPARED_PATHS = Object.freeze({ runtimeEnvironment: "runtime-paths.env" });
const PRIVATE_ARTIFACT_NAMES = Object.freeze([
  "bootstrapDocument",
  "makerAttestation",
  "makerPublicKey",
  "checkerAttestation",
  "checkerPublicKey",
  "siteReleaseCertificationKeys",
  "ownerPassword",
  "redemptionEntropy",
  "siteProviderRegistry",
  "authorizationEventKeys",
  "authorizationEventVerificationKeys",
  "commerceRedemptionKeys",
  "identityPasswordPeppers",
  "identityAuditKey",
] as const);

const operatorConfigSchema = z.object({
  schemaVersion: z.literal(1),
  ownerEmail: z.string().superRefine((value, context) => {
    try {
      if (normalizeIdentityEmail(value) !== value) throw new Error();
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "owner_email" });
    }
  }),
  model: z.object({
    endpoint: z.string().superRefine((value, context) => safeDirectEndpoint(value, context)),
    modelKey: z.string().regex(MODEL_IDENTIFIER),
  }).strict(),
}).strict();

const exactOciImage = z.string().regex(EXACT_OCI_IMAGE).superRefine((value, context) => {
  if (!safeOciImage(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "oci_image" });
  }
});

const webReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("kokoro.core-site-release"),
  webCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  siteId: z.string().regex(SITE_LIFECYCLE_REF),
  siteKey: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  releaseId: z.string().regex(SITE_LIFECYCLE_REF),
  finalSourceClosureSha256: z.string().regex(SHA256),
  lockSha256: z.string().regex(SHA256),
  packageArtifacts: z.record(z.string(), z.object({
    version: z.string().min(1).max(128),
    sha256: z.string().regex(SHA256),
  }).strict()).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 64),
  routes: z.array(z.string().startsWith("/").max(256).refine((value) =>
    !value.includes("\0") && !value.includes("\r") && !value.includes("\n")))
    .min(1).max(128).refine((value) => new Set(value).size === value.length),
  platform: z.enum(["linux/amd64", "linux/arm64"]),
  image: exactOciImage,
  webArtifactDigest: z.string().regex(SHA256),
}).strict().superRefine((value, context) => {
  if (ociDigest(value.image) !== value.webArtifactDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "image_digest" });
  }
});

const deploymentFactsSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("kokoro.core-single-site-deployment-facts"),
  environment: z.literal("production"),
  region: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  deploymentRef: z.string().regex(SITE_LIFECYCLE_REF),
  deploymentManifestDigest: z.string().regex(SHA256),
  webReportDigest: z.string().regex(SHA256),
  platformImage: exactOciImage,
  siteImage: exactOciImage,
  webArtifactDigest: z.string().regex(SHA256),
  publicOrigin: z.string().superRefine((value, context) => safePublicOrigin(value, context)),
  metadataEndpoint: z.literal(CORE_SINGLE_SITE_METADATA_ENDPOINT),
}).strict().superRefine((value, context) => {
  if (ociDigest(value.siteImage) !== value.webArtifactDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "image_digest" });
  }
});

export type CoreSingleSitePrepareOperatorConfig = Readonly<
  z.infer<typeof operatorConfigSchema>
>;
export type CoreSingleSitePrepareWebReport = Readonly<z.infer<typeof webReportSchema>>;
export type CoreSingleSitePrepareDeploymentFacts = Readonly<
  z.infer<typeof deploymentFactsSchema>
>;
export type CoreSingleSitePrepareInputs = Readonly<{
  operatorConfig: CoreSingleSitePrepareOperatorConfig;
  webReport: CoreSingleSitePrepareWebReport;
  deploymentFacts: CoreSingleSitePrepareDeploymentFacts;
  digests: Readonly<{
    operatorConfig: string;
    webReport: string;
    deploymentFacts: string;
    installation: string;
    prepareFacts: string;
  }>;
}>;

type CoreSingleSitePrivateArtifactName = typeof PRIVATE_ARTIFACT_NAMES[number];
type CoreSingleSiteInstallationPaths = Readonly<typeof PRIVATE_PATHS>;

export type CoreSingleSitePrepareResult = Readonly<{
  receiptPath: string;
  digest: string;
}>;

type PrivateArtifact = Readonly<{
  name: CoreSingleSitePrivateArtifactName;
  path: string;
  content: string | Uint8Array;
}>;

export type CoreSingleSitePrepareArguments = Readonly<{
  operatorConfig: string;
  webReport: string;
  deploymentFacts: string;
  stateDirectory: string;
}>;

export function coreSingleSitePrepareArguments(
  argv: readonly string[],
): CoreSingleSitePrepareArguments {
  if (argv.length !== ARGUMENTS.length * 2) invalidArguments();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) invalidArguments();
    const name = flag.slice(2);
    if (!(ARGUMENTS as readonly string[]).includes(name) || values.has(name) ||
        !safeAbsolutePath(value)) invalidArguments();
    values.set(name, value);
  }
  if (ARGUMENTS.some((name) => !values.has(name)) ||
      new Set(values.values()).size !== ARGUMENTS.length) invalidArguments();
  return Object.freeze({
    operatorConfig: values.get("operator-config")!,
    webReport: values.get("web-report")!,
    deploymentFacts: values.get("deployment-facts")!,
    stateDirectory: values.get("state-directory")!,
  });
}

export async function loadCoreSingleSitePrepareInputs(input: Readonly<{
  operatorConfigPath: string;
  webReportPath: string;
  deploymentFactsPath: string;
}>): Promise<CoreSingleSitePrepareInputs> {
  const [operatorText, webReportText, deploymentFactsText] = await Promise.all([
    readBoundedPrivateFile(input.operatorConfigPath, 64 * 1024,
      "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_FILE_INVALID"),
    readBoundedPrivateFile(input.webReportPath, 1024 * 1024,
      "CORE_SINGLE_SITE_PREPARE_WEB_REPORT_FILE_INVALID"),
    readBoundedPrivateFile(input.deploymentFactsPath, 64 * 1024,
      "CORE_SINGLE_SITE_PREPARE_DEPLOYMENT_FACTS_FILE_INVALID"),
  ]);
  const operatorConfig = parse(operatorText, operatorConfigSchema,
    "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_INVALID");
  const webReport = parse(webReportText, webReportSchema,
    "CORE_SINGLE_SITE_PREPARE_WEB_REPORT_INVALID");
  const deploymentFacts = parse(deploymentFactsText, deploymentFactsSchema,
    "CORE_SINGLE_SITE_PREPARE_DEPLOYMENT_FACTS_INVALID");
  const operatorConfigDigest = sha256(operatorText);
  const webReportDigest = sha256(webReportText);
  const deploymentFactsDigest = sha256(deploymentFactsText);
  if (deploymentFacts.webReportDigest !== webReportDigest ||
      deploymentFacts.siteImage !== webReport.image ||
      deploymentFacts.webArtifactDigest !== webReport.webArtifactDigest) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_FACTS_MISMATCH");
  }
  const installationDigest = createHash("sha256")
    .update("kokoro.core-single-site-prepare.installation.v1", "utf8")
    .update("\0", "utf8")
    .update(sha256(canonicalJson(operatorConfig)), "utf8")
    .update("\0", "utf8")
    .update(webReportDigest, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson({
      environment: deploymentFacts.environment,
      region: deploymentFacts.region,
      deploymentRef: deploymentFacts.deploymentRef,
      siteImage: deploymentFacts.siteImage,
      webArtifactDigest: deploymentFacts.webArtifactDigest,
      metadataEndpoint: deploymentFacts.metadataEndpoint,
    }), "utf8")
    .digest("hex");
  const prepareFactsDigest = createHash("sha256")
    .update("kokoro.core-single-site-prepare.facts.v1", "utf8")
    .update("\0", "utf8")
    .update(operatorConfigDigest, "utf8")
    .update("\0", "utf8")
    .update(webReportDigest, "utf8")
    .update("\0", "utf8")
    .update(deploymentFactsDigest, "utf8")
    .digest("hex");
  return deepFreeze({
    operatorConfig,
    webReport,
    deploymentFacts,
    digests: {
      operatorConfig: operatorConfigDigest,
      webReport: webReportDigest,
      deploymentFacts: deploymentFactsDigest,
      installation: installationDigest,
      prepareFacts: prepareFactsDigest,
    },
  });
}

export async function prepareCoreSingleSiteState(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  stateDirectory: string;
  now?: string;
}>): Promise<CoreSingleSitePrepareResult> {
  if (!safeAbsolutePath(input.stateDirectory)) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_STATE_DIRECTORY_INVALID");
  }
  const stateDirectory = resolve(input.stateDirectory);
  const installationRelative = `installations/${input.inputs.digests.installation}`;
  const preparedRelative = `prepared/${input.inputs.digests.prepareFacts}`;
  const installationDirectory = join(stateDirectory, installationRelative);
  const preparedDirectory = join(stateDirectory, preparedRelative);
  await ensurePrivateDirectory(stateDirectory);
  await ensurePrivateDirectory(join(stateDirectory, "installations"));
  await ensurePrivateDirectory(join(stateDirectory, "prepared"));

  const pointerPath = join(stateDirectory, "installation.json");
  const pointer = await optionalPrivateJson(pointerPath, 64 * 1024,
    "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  if (pointer !== null && pointer.installationDigest !== input.inputs.digests.installation) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_CONFIGURATION_CONFLICT");
  }
  if (pointer === null) {
    const existing = (await readdir(join(stateDirectory, "installations")))
      .filter((name) => !name.startsWith("."));
    if (existing.some((name) => name !== input.inputs.digests.installation)) {
      throw new Error("CORE_SINGLE_SITE_PREPARE_CONFIGURATION_CONFLICT");
    }
  }

  const pointerBody = Object.freeze({
    schemaVersion: 1,
    kind: "kokoro.core-single-site-installation",
    installationDigest: input.inputs.digests.installation,
    installationDirectory: installationRelative,
  });
  const expectedPointer = withDigest("kokoro.core-single-site-prepare.installation-pointer.v1",
    pointerBody);
  try {
    await publishExclusivePrivateFile(pointerPath, json(expectedPointer),
      "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  } catch {
    const claimed = await optionalPrivateJson(pointerPath, 64 * 1024,
      "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    if (claimed?.installationDigest !== input.inputs.digests.installation) {
      throw new Error("CORE_SINGLE_SITE_PREPARE_CONFIGURATION_CONFLICT");
    }
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
  await validateInstallationPointer(pointerPath, expectedPointer);
  let installation = await optionalValidatedInstallation({
    inputs: input.inputs,
    installationDirectory,
  });
  if (installation === null) {
    installation = await createInstallation({
      inputs: input.inputs,
      installationDirectory,
      now: canonicalInstant(input.now ?? new Date().toISOString()),
    });
  }
  installation = await requireValidatedInstallation({
    inputs: input.inputs,
    installationDirectory,
  });

  const runtimePathsText = runtimePathsEnvironment({
    inputs: input.inputs,
    document: installation.document,
    stateDirectory,
    installationDirectory,
  });
  const receiptBody = Object.freeze({
    schemaVersion: 1,
    kind: "kokoro.core-single-site-prepare-receipt",
    installationDigest: input.inputs.digests.installation,
    prepareFactsDigest: input.inputs.digests.prepareFacts,
    configDigest: installation.configDigest,
    inputDigests: Object.freeze({
      operatorConfig: input.inputs.digests.operatorConfig,
      webReport: input.inputs.digests.webReport,
      deploymentFacts: input.inputs.digests.deploymentFacts,
    }),
    verifiedDeployment: Object.freeze({
      deploymentManifestDigest: input.inputs.deploymentFacts.deploymentManifestDigest,
      platformImage: input.inputs.deploymentFacts.platformImage,
      siteImage: input.inputs.deploymentFacts.siteImage,
    }),
    installationDirectory: installationRelative,
    preparedDirectory: preparedRelative,
    paths: Object.freeze({ installation: PRIVATE_PATHS, prepared: PREPARED_PATHS }),
    privateArtifactsManifestDigest: installation.privateArtifactsManifestDigest,
    runtimePathsDigest: sha256(runtimePathsText),
  });
  const receipt = withDigest("kokoro.core-single-site-prepare.receipt.v1", receiptBody);
  const receiptPath = join(preparedDirectory, "prepare-receipt.json");
  const expectedPreparedFiles = Object.freeze({
    [PREPARED_PATHS.runtimeEnvironment]: runtimePathsText,
    "prepare-receipt.json": json(receipt),
  });
  await publishPreparedDirectory(preparedDirectory, expectedPreparedFiles);
  await validatePreparedDirectory(preparedDirectory, expectedPreparedFiles);
  return Object.freeze({ receiptPath, digest: receipt.digest });
}

export async function runCoreSingleSitePrepareMain(input: Readonly<{
  argv?: readonly string[];
  writeStdout?: (value: string) => void;
  now?: string;
}> = {}): Promise<CoreSingleSitePrepareResult> {
  const args = coreSingleSitePrepareArguments(input.argv ?? process.argv.slice(2));
  const inputs = await loadCoreSingleSitePrepareInputs({
    operatorConfigPath: args.operatorConfig,
    webReportPath: args.webReport,
    deploymentFactsPath: args.deploymentFacts,
  });
  const result = await prepareCoreSingleSiteState({
    inputs,
    stateDirectory: args.stateDirectory,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  (input.writeStdout ?? ((value: string) => process.stdout.write(value)))(
    `${JSON.stringify(result)}\n`,
  );
  return result;
}

async function createInstallation(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  installationDirectory: string;
  now: string;
}>): Promise<ValidatedInstallation> {
  const parent = dirname(input.installationDirectory);
  const temporary = join(parent,
    `.${input.inputs.digests.installation}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(temporary, { mode: 0o700 });
    const generated = generatePrivateArtifacts(input.inputs, input.now);
    for (const artifact of generated.artifacts) {
      const path = join(temporary, artifact.path);
      assertContained(temporary, path);
      await ensurePrivateDirectory(dirname(path));
      await writePrivateFile(path, artifact.content);
    }
    await ensurePrivateDirectory(join(temporary, PRIVATE_PATHS.outputDirectory));
    const manifestBody = Object.freeze({
      schemaVersion: 1,
      kind: "kokoro.core-single-site-private-artifacts",
      installationDigest: input.inputs.digests.installation,
      configDigest: generated.configDigest,
      artifacts: Object.freeze(generated.artifacts.map((artifact) => Object.freeze({
        name: artifact.name,
        path: artifact.path,
        sha256: sha256(artifact.content),
        bytes: Buffer.byteLength(artifact.content),
        mode: "0600",
      }))),
    });
    const manifest = withDigest("kokoro.core-single-site-prepare.private-artifacts.v1",
      manifestBody);
    await writePrivateFile(join(temporary, PRIVATE_PATHS.privateArtifactsManifest),
      json(manifest));
    await syncTreeDirectories(temporary);
    try {
      await rename(temporary, input.installationDirectory);
      await syncDirectory(parent);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return requireValidatedInstallation(input);
}

type ValidatedInstallation = Readonly<{
  configDigest: string;
  privateArtifactsManifestDigest: string;
  document: CoreSingleSiteBootstrapDocument;
}>;

async function optionalValidatedInstallation(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  installationDirectory: string;
}>): Promise<ValidatedInstallation | null> {
  try {
    return await validateInstallation(input);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
}

async function requireValidatedInstallation(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  installationDirectory: string;
}>): Promise<ValidatedInstallation> {
  try { return await validateInstallation(input); }
  catch { throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT"); }
}

async function validateInstallation(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  installationDirectory: string;
}>): Promise<ValidatedInstallation> {
  await assertPrivateDirectory(input.installationDirectory);
  await assertPrivateDirectory(join(input.installationDirectory, PRIVATE_PATHS.outputDirectory));
  await assertClosedInstallationTree(input.installationDirectory);
  const manifestPath = join(input.installationDirectory, PRIVATE_PATHS.privateArtifactsManifest);
  const manifestText = await readBoundedPrivateFile(manifestPath, 1024 * 1024,
    "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  const manifest = privateArtifactsManifestSchema.parse(JSON.parse(manifestText) as unknown);
  if (manifest.installationDigest !== input.inputs.digests.installation ||
      manifest.digest !== digestObject(
        "kokoro.core-single-site-prepare.private-artifacts.v1",
        withoutDigest(manifest),
      ) || manifest.artifacts.length !== PRIVATE_ARTIFACT_NAMES.length) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
  const expectedNames = new Set(PRIVATE_ARTIFACT_NAMES);
  for (const artifact of manifest.artifacts) {
    if (!expectedNames.delete(artifact.name) ||
        PRIVATE_PATHS[artifact.name as keyof CoreSingleSiteInstallationPaths] !== artifact.path) {
      throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    }
    const path = join(input.installationDirectory, artifact.path);
    assertContained(input.installationDirectory, path);
    const content = await readBoundedPrivateFile(path, 1024 * 1024,
      "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    if (Buffer.byteLength(content) !== artifact.bytes || sha256(content) !== artifact.sha256) {
      throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    }
  }
  if (expectedNames.size !== 0) throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  const artifactPath = (name: keyof CoreSingleSiteInstallationPaths) =>
    join(input.installationDirectory, PRIVATE_PATHS[name]);
  const document = parseCoreSingleSiteBootstrapDocument(JSON.parse(await readFile(
    artifactPath("bootstrapDocument"), "utf8")) as unknown, { KOKORO_ENVIRONMENT: "production" });
  assertDocumentMatchesInputs(document, input.inputs);
  const password = await readFile(artifactPath("ownerPassword"), "utf8");
  const entropy = await readFile(artifactPath("redemptionEntropy"));
  const certificationAuthority = new Ed25519SiteReleaseCertificationAuthority(
    parseSiteReleaseCertificationKeys(JSON.parse(await readFile(
      artifactPath("siteReleaseCertificationKeys"), "utf8")) as unknown),
  );
  await prepareCoreSingleSiteBootstrapExecution({
    document,
    secretDigests: {
      password: sha256(password),
      redemptionEntropy: sha256(entropy),
    },
    makerAttestations: parseCoreBootstrapAdminAttestationBundle(JSON.parse(await readFile(
      artifactPath("makerAttestation"), "utf8")) as unknown),
    makerPublicKey: publicKey(await readFile(artifactPath("makerPublicKey"), "utf8")),
    checkerAttestations: parseCoreBootstrapAdminAttestationBundle(JSON.parse(await readFile(
      artifactPath("checkerAttestation"), "utf8")) as unknown),
    checkerPublicKey: publicKey(await readFile(artifactPath("checkerPublicKey"), "utf8")),
    certificationAuthority,
    now: document.site.releaseCertification.issuedAt,
    environment: { PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: document.model.endpoint },
  });
  await assertFixedSiteProviderBinding(artifactPath("siteProviderRegistry"), {
    namespace: document.site.providerNamespace,
    metadataEndpoint: document.site.metadataEndpoint,
  });
  const [authorizationEventKeys, authorizationEventVerificationKeys] = await Promise.all([
    loadAuthorizationEventKeyRing(artifactPath("authorizationEventKeys")),
    loadAuthorizationVerificationKeys(
      artifactPath("authorizationEventVerificationKeys"),
      "event_signing",
    ),
  ]);
  await createSessionAuthorizationEventSigner(authorizationEventKeys);
  assertAuthorizationEventKeyParity(
    authorizationEventKeys.keys,
    authorizationEventVerificationKeys,
  );
  await Promise.all([
    loadIdentityPasswordHasher(artifactPath("identityPasswordPeppers")),
    loadIdentityAuditDigester(artifactPath("identityAuditKey")),
    loadRedemptionSecretCodec(artifactPath("commerceRedemptionKeys")),
  ]);
  const configDigest = coreBootstrapConfigDigest(document, {
    password: sha256(password),
    redemptionEntropy: sha256(entropy),
  });
  if (manifest.configDigest !== configDigest) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
  return Object.freeze({
    configDigest,
    privateArtifactsManifestDigest: sha256(manifestText),
    document,
  });
}

async function assertClosedInstallationTree(root: string): Promise<void> {
  const expectedFiles = new Set<string>([
    ...PRIVATE_ARTIFACT_NAMES.map((name) => PRIVATE_PATHS[name]),
    PRIVATE_PATHS.privateArtifactsManifest,
  ]);
  const expectedDirectories = new Set<string>([
    "bootstrap",
    "bootstrap/authorization",
    "secrets",
    "secrets/platform-admin",
    "secrets/platform-core-bootstrap",
    "secrets/platform-api",
    "secrets/platform-authorization",
    PRIVATE_PATHS.outputDirectory,
  ]);
  async function visit(directory: string): Promise<void> {
    const current = relative(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = current === "" ? entry.name : `${current}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
      if (entry.isDirectory()) {
        if (!expectedDirectories.delete(relativePath)) {
          throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
        }
        await assertPrivateDirectory(join(directory, entry.name));
        if (relativePath !== PRIVATE_PATHS.outputDirectory) await visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        if (!expectedFiles.delete(relativePath)) {
          throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
        }
      } else {
        throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
      }
    }
  }
  await visit(root);
  if (expectedFiles.size !== 0 || expectedDirectories.size !== 0) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
}

function generatePrivateArtifacts(
  inputs: CoreSingleSitePrepareInputs,
  now: string,
): Readonly<{ artifacts: readonly PrivateArtifact[]; configDigest: string }> {
  const bootstrapId = deterministicUuid(inputs.digests.installation, "bootstrap");
  const accountRef = coreBootstrapUuid(bootstrapId, "identity.account");
  const batchRef = coreBootstrapUuid(bootstrapId, "commerce.code-batch");
  const expiresAt = new Date(Date.parse(now) + 366 * 24 * 60 * 60 * 1000).toISOString();
  const model = deriveCoreSingleSiteBootstrapModelArtifacts({
    siteId: inputs.webReport.siteId,
    siteReleaseRef: inputs.webReport.releaseId,
    publishedAt: now,
    inventoryRef: "model-inventory:core-single-site-v1",
    modelKey: inputs.operatorConfig.model.modelKey,
    modelOptionKey: "chat.standard",
  });
  const certificationKeys = generateKeyPairSync("ed25519");
  const certificationKeyRef = `core-site-cert-${inputs.digests.installation.slice(0, 16)}`;
  const proof = Object.freeze({ signingKeyRef: certificationKeyRef, issuedAt: now, expiresAt });
  const provisional = parseCoreSingleSiteBootstrapDocument({
    version: 1,
    bootstrapId,
    environment: inputs.deploymentFacts.environment,
    region: inputs.deploymentFacts.region,
    makerSubjectRef: "operator:core-bootstrap-maker",
    checkerSubjectRef: "operator:core-bootstrap-checker",
    site: {
      siteId: inputs.webReport.siteId,
      siteKey: inputs.webReport.siteKey,
      siteReleaseRef: inputs.webReport.releaseId,
      siteProjectBindingRef: `site-binding:${inputs.webReport.siteKey}:1`,
      workloadIdentityId: `spiffe://kokoro/site/${inputs.webReport.siteKey}`,
      workloadBindingEpoch: "1",
      providerNamespace: "core.fixed",
      providerProjectRef: inputs.webReport.siteKey,
      metadataEndpoint: inputs.deploymentFacts.metadataEndpoint,
      webArtifactDigest: inputs.webReport.webArtifactDigest,
      releaseManifestDigest: inputs.digests.webReport,
      certificationDigest: "0".repeat(64),
      releaseCertification: { ...proof, signature: "A".repeat(86) },
      audience: "site-product",
      sessionContractRevision: "session-browser-v3",
    },
    model: {
      provider: "direct",
      providerKey: "direct",
      modelKey: inputs.operatorConfig.model.modelKey,
      modelOptionKey: "chat.standard",
      endpoint: inputs.operatorConfig.model.endpoint,
      inventoryRef: "model-inventory:core-single-site-v1",
      optionRevisionRef: model.modelOptionRevisionRef,
      catalogRef: model.modelOptionCatalogRef,
    },
    rating: {
      policyRevisionRef: "rating-policy:core-single-site-v1",
      unit: "credit",
      inputTokenAmount: "1",
      outputTokenAmount: "1",
    },
    redemption: {
      creditProgramRevisionRef: "credit-program:core-single-site-v1",
      productVersionRef: "product:core-single-site-v1",
      fulfillmentProgramRevisionRef: "fulfillment:core-single-site-v1",
      programRevisionRef: "redemption-program:core-single-site-v1",
      batchRef,
      amount: "250000",
      liabilityMerchantAccountRef: "merchant:core-single-site",
      entropyKeyFile: CONTAINER_REDEMPTION_ENTROPY,
    },
    identity: {
      email: inputs.operatorConfig.ownerEmail,
      passwordFile: CONTAINER_OWNER_PASSWORD,
      accountRef,
      subjectRef: "subject:core-owner",
      workspaceRef: "workspace:core-owner",
      projectRef: "project:core-owner",
      billingAccountRef: "billing:core-owner",
      executionSpaceRef: "execution-space:core-owner",
      executionNamespace: `namespace_${inputs.digests.installation.slice(0, 56)}`,
    },
    externalEmptyAgentCatalogRef: CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_REF,
  }, { KOKORO_ENVIRONMENT: inputs.deploymentFacts.environment });
  const provisionalRecipe = createCoreSingleSiteBootstrapRecipe(provisional);
  const certificationPayload = canonicalCertificationPayload({
    ...provisionalRecipe.siteRelease,
    proof,
  });
  const certificationDigest = sha256(certificationPayload);
  const certificationSignature = sign(null, Buffer.concat([
    Buffer.from("kokoro.site-release-certification.v1\0", "utf8"),
    Buffer.from(certificationPayload, "utf8"),
  ]), certificationKeys.privateKey).toString("base64url");
  const document = parseCoreSingleSiteBootstrapDocument({
    ...provisional,
    site: {
      ...provisional.site,
      certificationDigest,
      releaseCertification: { ...proof, signature: certificationSignature },
    },
  }, { KOKORO_ENVIRONMENT: inputs.deploymentFacts.environment });
  createCoreSingleSiteBootstrapRecipe(document);

  const ownerPassword = randomBytes(32).toString("base64url");
  const redemptionEntropy = randomBytes(32).toString("base64url");
  const makerKeys = generateKeyPairSync("ed25519");
  const checkerKeys = generateKeyPairSync("ed25519");
  const makerBundle = signedAdminBundle({
    operations: CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
    operatorRef: document.makerSubjectRef,
    privateKey: makerKeys.privateKey,
    document,
    issuedAt: now,
    expiresAt,
    role: "maker",
  });
  const checkerBundle = signedAdminBundle({
    operations: CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
    operatorRef: document.checkerSubjectRef,
    privateKey: checkerKeys.privateKey,
    document,
    issuedAt: now,
    expiresAt,
    role: "checker",
  });
  const authorizationKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const suffix = inputs.digests.installation.slice(0, 16);
  const authorizationEventKey = Object.freeze({
    keyRevision: `core-auth-${suffix}`,
    publicKeyPem: publicPem(authorizationKeys.publicKey),
    privateKeyPem: privatePem(authorizationKeys.privateKey),
    current: true,
    notBefore: now,
    notAfter: IMMUTABLE_AUTHORIZATION_KEY_NOT_AFTER,
  });
  const artifacts: readonly PrivateArtifact[] = Object.freeze([
    artifact("bootstrapDocument", json(document)),
    artifact("makerAttestation", json(makerBundle)),
    artifact("makerPublicKey", publicPem(makerKeys.publicKey)),
    artifact("checkerAttestation", json(checkerBundle)),
    artifact("checkerPublicKey", publicPem(checkerKeys.publicKey)),
    artifact("siteReleaseCertificationKeys", json({
      version: 1,
      keys: [{
        signingKeyRef: certificationKeyRef,
        algorithm: "Ed25519",
        publicKeyPem: publicPem(certificationKeys.publicKey),
      }],
    })),
    artifact("ownerPassword", ownerPassword),
    artifact("redemptionEntropy", redemptionEntropy),
    artifact("siteProviderRegistry", json({
      version: 1,
      providers: [{
        kind: "fixed_http",
        namespace: document.site.providerNamespace,
        metadataEndpoint: document.site.metadataEndpoint,
        timeoutMs: 5_000,
      }],
    })),
    artifact("authorizationEventKeys", json({
      version: 1,
      keys: [authorizationEventKey],
    })),
    artifact("authorizationEventVerificationKeys", json({
      version: 1,
      purpose: "event_signing",
      keys: [{
        keyRevision: authorizationEventKey.keyRevision,
        publicKeyPem: authorizationEventKey.publicKeyPem,
        current: authorizationEventKey.current,
        notBefore: authorizationEventKey.notBefore,
        notAfter: authorizationEventKey.notAfter,
      }],
    })),
    artifact("commerceRedemptionKeys", json({
      version: 1,
      currentCodeLookupKeyRevision: `core-code-${suffix}`,
      codeLookupKeys: [{
        keyRevision: `core-code-${suffix}`,
        keyBase64url: randomBytes(32).toString("base64url"),
      }],
      currentPreviewCredentialKeyRevision: `core-preview-${suffix}`,
      previewCredentialKeys: [{
        keyRevision: `core-preview-${suffix}`,
        keyBase64url: randomBytes(32).toString("base64url"),
      }],
      requestAuditKeyBase64url: randomBytes(32).toString("base64url"),
    })),
    artifact("identityPasswordPeppers", json({
      version: 1,
      currentPepperVersion: 1,
      peppers: [{ version: 1, secretBase64url: randomBytes(32).toString("base64url") }],
      memoryCostKiB: 19_456,
      timeCost: 2,
      parallelism: 1,
    })),
    artifact("identityAuditKey", randomBytes(32).toString("base64url")),
  ]);
  const configDigest = coreBootstrapConfigDigest(document, {
    password: sha256(ownerPassword),
    redemptionEntropy: sha256(redemptionEntropy),
  });
  return Object.freeze({ artifacts, configDigest });
}

function signedAdminBundle(input: Readonly<{
  operations: readonly string[];
  operatorRef: string;
  privateKey: KeyObject;
  document: CoreSingleSiteBootstrapDocument;
  issuedAt: string;
  expiresAt: string;
  role: "maker" | "checker";
}>): CoreBootstrapAdminAttestationBundle {
  return Object.freeze({
    version: 1,
    attestations: Object.freeze(input.operations.map((operation) => {
      const context = adminContext({ ...input, operation });
      return Object.freeze({
        operation,
        envelope: Object.freeze({
          context,
          signature: sign(
            null,
            coreBootstrapAdminAttestationPayload(context),
            input.privateKey,
          ).toString("base64"),
          keyVersion: `core-${input.role}-1`,
        }),
      });
    })),
  });
}

function adminContext(input: Readonly<{
  operation: string;
  operatorRef: string;
  document: CoreSingleSiteBootstrapDocument;
  issuedAt: string;
  expiresAt: string;
  role: "maker" | "checker";
}>): RequestSecurityContext {
  const target = coreSingleSiteBootstrapAttestationTarget(input.operation, input.document);
  const requestRef = `${input.role}:${input.operation}`;
  return Object.freeze({
    requestId: `core-bootstrap-request:${requestRef}`,
    correlationId: `core-bootstrap-correlation:${requestRef}`,
    trustedCaller: Object.freeze({
      workloadIdentityId: `spiffe://kokoro/admin/core-bootstrap-${input.role}`,
      kind: "admin_workload",
      audience: ADMIN_AUDIENCE,
      environment: input.document.environment,
      region: input.document.region,
      allowedOperations: coreSingleSiteBootstrapAttestationAllowedOperations(input.operation),
      bindingEpoch: "1",
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    }),
    actor: Object.freeze({
      kind: "operator",
      subjectId: input.operatorRef,
      subjectGeneration: "1",
    }),
    delegatedGrant: null,
    target: Object.freeze({
      siteId: target.siteId,
      workspaceId: null,
      projectId: null,
      purpose: target.purpose,
      scopes: target.scopes,
    }),
    audience: ADMIN_AUDIENCE,
    environment: input.document.environment,
    region: input.document.region,
    evidence: Object.freeze([Object.freeze({
      kind: "signature",
      evidenceId: `core-bootstrap-evidence:${requestRef}`,
      issuer: `core-bootstrap-${input.role}`,
    })]),
    policyEpoch: "1",
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
}

function artifact(
  name: CoreSingleSitePrivateArtifactName,
  content: string | Uint8Array,
): PrivateArtifact {
  return Object.freeze({ name, path: PRIVATE_PATHS[name], content });
}

function publicPem(key: KeyObject): string {
  return String(key.export({ type: "spki", format: "pem" }));
}

function privatePem(key: KeyObject): string {
  return String(key.export({ type: "pkcs8", format: "pem" }));
}

function publicKey(value: string): KeyObject {
  const key = createPublicKey(value);
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
  return key;
}

function assertAuthorizationEventKeyParity(
  signingKeys: readonly Readonly<{
    keyRevision: string;
    publicKeyPem: string;
    current: boolean;
    notBefore: string;
    notAfter: string;
  }>[],
  verificationKeys: readonly Readonly<{
    purpose: string;
    keyRevision: string;
    publicKeyPem: string;
    current: boolean;
    notBefore: string;
    notAfter: string;
  }>[],
): void {
  if (signingKeys.length !== verificationKeys.length) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
  const verificationByRevision = new Map(verificationKeys.map((key) => [key.keyRevision, key]));
  if (verificationByRevision.size !== verificationKeys.length || signingKeys.some((signing) => {
    const verification = verificationByRevision.get(signing.keyRevision);
    return verification === undefined || verification.purpose !== "event_signing" ||
      verification.publicKeyPem !== signing.publicKeyPem ||
      verification.current !== signing.current ||
      verification.notBefore !== signing.notBefore ||
      verification.notAfter !== signing.notAfter;
  })) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
}

function deterministicUuid(seed: string, label: string): string {
  const bytes = createHash("sha256")
    .update("kokoro.core-single-site-prepare.uuid.v1", "utf8")
    .update("\0", "utf8")
    .update(seed, "utf8")
    .update("\0", "utf8")
    .update(label, "utf8")
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertDocumentMatchesInputs(
  document: CoreSingleSiteBootstrapDocument,
  inputs: CoreSingleSitePrepareInputs,
): void {
  if (document.environment !== inputs.deploymentFacts.environment ||
      document.region !== inputs.deploymentFacts.region ||
      document.site.siteId !== inputs.webReport.siteId ||
      document.site.siteKey !== inputs.webReport.siteKey ||
      document.site.siteReleaseRef !== inputs.webReport.releaseId ||
      document.site.metadataEndpoint !== CORE_SINGLE_SITE_METADATA_ENDPOINT ||
      document.site.webArtifactDigest !== inputs.webReport.webArtifactDigest ||
      document.site.releaseManifestDigest !== inputs.digests.webReport ||
      document.model.endpoint !== inputs.operatorConfig.model.endpoint ||
      document.model.modelKey !== inputs.operatorConfig.model.modelKey ||
      document.identity.email !== inputs.operatorConfig.ownerEmail ||
      document.identity.passwordFile !== CONTAINER_OWNER_PASSWORD ||
      document.redemption.entropyKeyFile !== CONTAINER_REDEMPTION_ENTROPY ||
      document.externalEmptyAgentCatalogRef !==
        CORE_SINGLE_SITE_BOOTSTRAP_EMPTY_AGENT_CATALOG_REF) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  }
}

const privateArtifactsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("kokoro.core-single-site-private-artifacts"),
  installationDigest: z.string().regex(SHA256),
  configDigest: z.string().regex(SHA256),
  artifacts: z.array(z.object({
    name: z.enum(PRIVATE_ARTIFACT_NAMES),
    path: z.string().min(1).max(512),
    sha256: z.string().regex(SHA256),
    bytes: z.number().int().positive().max(1024 * 1024),
    mode: z.literal("0600"),
  }).strict()),
  digest: z.string().regex(SHA256),
}).strict();

function runtimePathsEnvironment(input: Readonly<{
  inputs: CoreSingleSitePrepareInputs;
  document: CoreSingleSiteBootstrapDocument;
  stateDirectory: string;
  installationDirectory: string;
}>): string {
  const values = Object.freeze({
    KOKORO_CORE_STATE_DIR: input.installationDirectory,
    KOKORO_ENVIRONMENT: input.inputs.deploymentFacts.environment,
    KOKORO_PLATFORM_IMAGE: input.inputs.deploymentFacts.platformImage,
    KOKORO_SITE_IMAGE: input.inputs.deploymentFacts.siteImage,
    KOKORO_SITE_DEPLOYMENT_REF: input.inputs.deploymentFacts.deploymentRef,
    KOKORO_SITE_RELEASE_REF: input.inputs.webReport.releaseId,
    KOKORO_WEB_ARTIFACT_DIGEST: input.inputs.webReport.webArtifactDigest,
    KOKORO_SITE_PUBLIC_ORIGIN: input.inputs.deploymentFacts.publicOrigin,
    PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: input.inputs.operatorConfig.model.endpoint,
    KOKORO_SITE_ID: input.document.site.siteId,
    KOKORO_SITE_KEY: input.document.site.siteKey,
    KOKORO_SITE_PROJECT_BINDING_REF: input.document.site.siteProjectBindingRef,
    KOKORO_SITE_WORKLOAD_IDENTITY_ID: input.document.site.workloadIdentityId,
    KOKORO_PRODUCT_AUDIENCE: input.document.site.audience,
    KOKORO_SESSION_CONTRACT_REVISION: input.document.site.sessionContractRevision,
    KOKORO_SITE_BINDING_EPOCH: "2",
    KOKORO_SITE_SECURITY_EPOCH: "1",
    KOKORO_SITE_POLICY_EPOCH: "2",
    KOKORO_PLATFORM_PUBLIC_OPERATION_IDS_JSON: JSON.stringify(
      CORE_SINGLE_SITE_PUBLIC_OPERATION_IDS,
    ),
  });
  assertContained(input.stateDirectory, input.installationDirectory);
  return `${Object.entries(values).map(([name, value]) => `${name}=${shellQuote(value)}`).join("\n")}\n`;
}

async function publishPreparedDirectory(
  path: string,
  expectedFiles: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await validatePreparedDirectory(path, expectedFiles);
    return;
  } catch (error) {
    if (!isMissing(error)) {
      if (error instanceof Error &&
          error.message === "CORE_SINGLE_SITE_PREPARE_PREPARED_CONFLICT") throw error;
      throw new Error("CORE_SINGLE_SITE_PREPARE_PREPARED_CONFLICT");
    }
  }
  const parent = dirname(path);
  const temporary = join(parent, `.${path.slice(path.lastIndexOf(sep) + 1)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await mkdir(temporary, { mode: 0o700 });
    for (const [relativePath, content] of Object.entries(expectedFiles)) {
      await writePrivateFile(join(temporary, relativePath), content);
    }
    await syncTreeDirectories(temporary);
    try {
      await rename(temporary, path);
      await syncDirectory(parent);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function validatePreparedDirectory(
  path: string,
  expectedFiles: Readonly<Record<string, string>>,
): Promise<void> {
  await assertPrivateDirectory(path);
  const entries = (await readdir(path)).sort();
  const expectedEntries = Object.keys(expectedFiles).sort();
  if (entries.length !== expectedEntries.length ||
      entries.some((name, index) => name !== expectedEntries[index])) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_PREPARED_CONFLICT");
  }
  for (const [relativePath, content] of Object.entries(expectedFiles)) {
    const actual = await readBoundedPrivateFile(join(path, relativePath), 1024 * 1024,
      "CORE_SINGLE_SITE_PREPARE_PREPARED_CONFLICT");
    if (actual !== content) throw new Error("CORE_SINGLE_SITE_PREPARE_PREPARED_CONFLICT");
  }
}

async function validateInstallationPointer(
  path: string,
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  const actual = await readBoundedPrivateFile(path, 64 * 1024,
    "CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
  if (actual !== json(expected)) throw new Error("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
}

async function optionalPrivateJson(
  path: string,
  maximumBytes: number,
  code: string,
): Promise<Record<string, unknown> | null> {
  try { await lstat(path); }
  catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const source = await readBoundedPrivateFile(path, maximumBytes, code);
    const value = JSON.parse(source) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as Record<string, unknown>;
  } catch { throw new Error(code); }
}

async function publishExclusivePrivateFile(
  path: string,
  content: string,
  conflictCode: string,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writePrivateFile(temporary, content);
    try {
      await link(temporary, path);
      await syncDirectory(dirname(path));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readBoundedPrivateFile(path, 64 * 1024, conflictCode);
      if (existing !== content) throw new Error(conflictCode);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { recursive: true, mode: 0o700 }); }
  catch { throw new Error("CORE_SINGLE_SITE_PREPARE_STATE_DIRECTORY_INVALID"); }
  await assertPrivateDirectory(path);
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_STATE_DIRECTORY_INVALID");
  }
}

async function syncTreeDirectories(root: string): Promise<void> {
  const directories: string[] = [];
  async function visit(path: string): Promise<void> {
    directories.push(path);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(path, entry.name));
    }
  }
  await visit(root);
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function withDigest<Value extends Readonly<Record<string, unknown>>>(
  domain: string,
  value: Value,
): Value & Readonly<{ digest: string }> {
  return deepFreeze({ ...value, digest: digestObject(domain, value) });
}

function digestObject(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function withoutDigest<Value extends Readonly<Record<string, unknown>>>(value: Value) {
  const { digest: _digest, ...body } = value;
  return body;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertContained(root: string, path: string): void {
  const child = relative(resolve(root), resolve(path));
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    if (child !== "") throw new Error("CORE_SINGLE_SITE_PREPARE_PATH_INVALID");
  }
}

function safeAbsolutePath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0") && !path.includes("\r") &&
    !path.includes("\n");
}

function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("CORE_SINGLE_SITE_PREPARE_TIME_INVALID");
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    ["EEXIST", "ENOTEMPTY"].includes(String(error.code));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function invalidArguments(): never {
  throw new Error("CORE_SINGLE_SITE_PREPARE_ARGUMENTS_INVALID");
}

function parse<Schema extends z.ZodTypeAny>(
  source: string,
  schema: Schema,
  code: string,
): z.output<Schema> {
  let raw: unknown;
  try { raw = JSON.parse(source) as unknown; }
  catch { throw new Error(code); }
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(code);
  return result.data;
}

function ociDigest(image: string): string | undefined {
  return EXACT_OCI_IMAGE.exec(image)?.groups?.digest;
}

function safeOciImage(image: string): boolean {
  const repository = EXACT_OCI_IMAGE.exec(image)?.groups?.repository;
  if (repository === undefined) return false;
  const separator = repository.indexOf("/");
  if (separator < 1) return false;
  try {
    const registry = new URL(`https://${repository.slice(0, separator)}`);
    return registry.pathname === "/" && registry.username === "" && registry.password === "" &&
      registry.hostname !== "localhost" && !registry.hostname.endsWith(".invalid") &&
      isIP(registry.hostname) === 0 && DNS_HOSTNAME.test(registry.hostname);
  } catch {
    return false;
  }
}

function safeDirectEndpoint(value: string, context: z.RefinementCtx): void {
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "model_endpoint" });
    return;
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.search !== "" || endpoint.hash !== "" || endpoint.hostname === "localhost" ||
      endpoint.hostname.endsWith(".invalid") ||
      isIP(endpoint.hostname) !== 0 || !endpoint.hostname.includes(".") ||
      endpoint.pathname.includes("..") || endpoint.href !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "model_endpoint" });
  }
}

function safePublicOrigin(value: string, context: z.RefinementCtx): void {
  let origin: URL;
  try { origin = new URL(value); }
  catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "public_origin" });
    return;
  }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" ||
      origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      origin.hostname === "localhost" || origin.hostname.endsWith(".invalid") ||
      isIP(origin.hostname) !== 0 ||
      !origin.hostname.includes(".") || origin.origin !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "public_origin" });
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runCoreSingleSitePrepareMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform core single-Site prepare failed",
      error instanceof Error ? error.message : "CORE_SINGLE_SITE_PREPARE_FAILED");
  });
}
