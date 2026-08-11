import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CoreSingleSiteBootstrapResult } from
  "./core-single-site-bootstrap-composition.js";
import {
  assertCoreSingleSiteBootstrapRuntimeConfiguration,
  assertCoreSingleSiteBootstrapSiteProviderConfiguration,
  coreSingleSiteBootstrapDatabaseEnvironments,
  createCoreSingleSiteBootstrapProductionOwners,
  createCoreSingleSiteBootstrapProductionCodeRecovery,
  createCoreSingleSiteBootstrapProductionRecovery,
  executeCoreSingleSiteBootstrap,
  prepareCoreSingleSiteBootstrapExecution,
  recoverCompletedCoreSingleSiteBootstrap,
  type CoreSingleSiteBootstrapPersistedCodeIdentity,
  type CoreSingleSiteBootstrapProductionDatabases,
} from "./core-single-site-bootstrap-composition.js";
import {
  loadCoreSingleSiteBootstrapDocument,
  loadCoreSingleSiteBootstrapSecretMaterial,
} from "./core-single-site-bootstrap-document.js";
import { parseCoreBootstrapAdminAttestationBundle } from
  "./core-single-site-bootstrap-attestation.js";
import {
  Ed25519SiteReleaseCertificationAuthority,
  parseSiteReleaseCertificationKeys,
} from "../modules/site/infrastructure/crypto/site-release-certification-authority.js";
import { readBoundedPrivateFile, readBoundedRegularFile } from "./secret-files.js";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
  type PlatformTransactionalDatabaseClient,
} from "../infrastructure/postgres/client.js";

const ARGUMENTS = Object.freeze([
  "file",
  "result",
  "redemption-code",
  "maker-attestation",
  "maker-public-key",
  "checker-attestation",
  "checker-public-key",
] as const);

export type CoreSingleSiteBootstrapArguments = Readonly<{
  file: string;
  result: string;
  redemptionCode: string;
  makerAttestation: string;
  makerPublicKey: string;
  checkerAttestation: string;
  checkerPublicKey: string;
}>;

export function coreSingleSiteBootstrapArguments(
  argv: readonly string[],
): CoreSingleSiteBootstrapArguments {
  if (argv.length !== ARGUMENTS.length * 2) invalidArguments();
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) invalidArguments();
    const name = flag.slice(2);
    if (!(ARGUMENTS as readonly string[]).includes(name) || values.has(name) ||
        !isAbsolute(value)) invalidArguments();
    values.set(name, value);
  }
  if (ARGUMENTS.some((name) => !values.has(name))) invalidArguments();
  return Object.freeze({
    file: values.get("file")!,
    result: values.get("result")!,
    redemptionCode: values.get("redemption-code")!,
    makerAttestation: values.get("maker-attestation")!,
    makerPublicKey: values.get("maker-public-key")!,
    checkerAttestation: values.get("checker-attestation")!,
    checkerPublicKey: values.get("checker-public-key")!,
  });
}

export async function publishCoreSingleSiteBootstrapOutputs(input: Readonly<{
  resultPath: string;
  redemptionCodePath: string;
  result: CoreSingleSiteBootstrapResult;
  redemptionCode: string;
  persisted: CoreSingleSiteBootstrapPersistedCodeIdentity;
  allowCreateCode: boolean;
}>): Promise<Readonly<{ resultPath: string; resultDigest: string }>> {
  if (!isAbsolute(input.resultPath) || !isAbsolute(input.redemptionCodePath) ||
      input.resultPath === input.redemptionCodePath ||
      `${input.resultPath}.pair` === input.redemptionCodePath ||
      !validRedemptionCode(input.redemptionCode) ||
      input.persisted.safeFingerprint !== input.result.redemption.safeCodeFingerprint ||
      !validPersistedCodeIdentity(input.persisted)) {
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_INVALID");
  }
  const resultText = `${JSON.stringify(input.result)}\n`;
  const codeText = `${input.redemptionCode}\n`;
  const pairPath = `${input.resultPath}.pair`;
  const pairText = `${JSON.stringify({
    schemaVersion: 1,
    kind: "kokoro-core-single-site-bootstrap-output-pair",
    bootstrapId: input.result.bootstrapId,
    configDigest: input.result.configDigest,
    resultPath: input.resultPath,
    redemptionCodePath: input.redemptionCodePath,
    resultDigest: createHash("sha256").update(resultText, "utf8").digest("hex"),
    redemptionCodeDigest: createHash("sha256").update(codeText, "utf8").digest("hex"),
    codeIdentity: {
      safeFingerprint: input.persisted.safeFingerprint,
      keyRevision: input.persisted.keyRevision,
      batchSelector: input.persisted.batchSelector,
      lookupDigest: input.persisted.lookupDigest,
    },
  })}\n`;
  if (!input.allowCreateCode) {
    try {
      const existing = await Promise.all([
        matchingExistingPrivateFile(pairPath, pairText),
        matchingExistingPrivateFile(input.redemptionCodePath, codeText),
        matchingExistingPrivateFile(input.resultPath, resultText),
      ]);
      if (existing.some((value) => !value)) throw new Error();
    } catch {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_CODE_EXPORT_UNRECOVERABLE");
    }
    return Object.freeze({
      resultPath: input.resultPath,
      resultDigest: createHash("sha256").update(resultText, "utf8").digest("hex"),
    });
  }
  await Promise.all([
    matchingExistingPrivateFile(pairPath, pairText),
    matchingExistingPrivateFile(input.redemptionCodePath, codeText),
    matchingExistingPrivateFile(input.resultPath, resultText),
  ]);
  await publishAtomicPrivateFile(pairPath, pairText);
  await Promise.all([
    matchingExistingPrivateFile(input.redemptionCodePath, codeText),
    matchingExistingPrivateFile(input.resultPath, resultText),
  ]);
  await publishAtomicPrivateFile(input.redemptionCodePath, codeText);
  await publishAtomicPrivateFile(input.resultPath, resultText);
  return Object.freeze({
    resultPath: input.resultPath,
    resultDigest: createHash("sha256").update(resultText, "utf8").digest("hex"),
  });
}

async function matchingExistingPrivateFile(path: string, expected: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 ||
        metadata.size > 1024 * 1024 || await handle.readFile("utf8") !== expected) {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    if (error instanceof Error && error.message === "CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT") {
      throw error;
    }
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
  } finally {
    await handle?.close();
  }
}

function validRedemptionCode(value: string): boolean {
  return /^KC1-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{10}-[0-9A-HJKMNP-TV-Z]{32}-[0-9A-HJKMNP-TV-Z]{8}$/u
    .test(value);
}

function validPersistedCodeIdentity(value: CoreSingleSiteBootstrapPersistedCodeIdentity): boolean {
  return /^CODE-[A-Z0-9]{16}$/u.test(value.safeFingerprint) &&
    /^[A-Za-z0-9_-]{1,64}$/u.test(value.keyRevision) &&
    /^[0-9A-HJKMNP-TV-Z]{10}$/u.test(value.batchSelector) &&
    /^[a-f0-9]{64}$/u.test(value.lookupDigest) &&
    ["available", "claimed", "void"].includes(value.state);
}

export async function resolveCoreSingleSiteBootstrapCompletion<Result>(input: Readonly<{
  recoverCompleted(): Promise<Result | null>;
  executeWithFreshAuthority(): Promise<Result>;
}>): Promise<Result> {
  const recovered = await input.recoverCompleted();
  return recovered ?? input.executeWithFreshAuthority();
}

export async function runCoreSingleSiteBootstrapMain(input: Readonly<{
  argv?: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  writeStdout?: (value: string) => void;
  now?: () => string;
}> = {}): Promise<Readonly<{ resultPath: string; resultDigest: string }>> {
  const environment = input.environment ?? process.env;
  const args = coreSingleSiteBootstrapArguments(input.argv ?? process.argv.slice(2));
  const document = await loadCoreSingleSiteBootstrapDocument(args.file, environment);
  const material = await loadCoreSingleSiteBootstrapSecretMaterial(document);
  assertCoreSingleSiteBootstrapRuntimeConfiguration(document, environment);
  await assertCoreSingleSiteBootstrapSiteProviderConfiguration(document, environment);
  const databaseSet = createProductionDatabaseSet(environment);
  try {
    await databaseSet.databases.admin.connect();
    let codeRecovery: ReturnType<typeof createCoreSingleSiteBootstrapProductionCodeRecovery>
      | undefined;
    const reconstructCode = async (value: Parameters<Awaited<ReturnType<
      typeof createCoreSingleSiteBootstrapProductionCodeRecovery>>>[0]) => {
      codeRecovery ??= createCoreSingleSiteBootstrapProductionCodeRecovery({
        database: databaseSet.databases.admin,
        document,
        redemptionEntropySecret: material.redemptionEntropySecret,
        environment,
      });
      return (await codeRecovery)(value);
    };
    const completed = await resolveCoreSingleSiteBootstrapCompletion({
      recoverCompleted: () => recoverCompletedCoreSingleSiteBootstrap({
        document,
        secretDigests: material.secretDigests,
        recovery: createCoreSingleSiteBootstrapProductionRecovery(databaseSet.databases.admin),
        reconstructCode,
      }),
      executeWithFreshAuthority: async () => {
        const [makerBundleText, makerPublicKeyPem, checkerBundleText,
          checkerPublicKeyPem, certificationKeysText] = await Promise.all([
          readBoundedPrivateFile(args.makerAttestation, 1024 * 1024,
            "CORE_SINGLE_SITE_BOOTSTRAP_MAKER_ATTESTATION_FILE_INVALID"),
          readBoundedRegularFile(args.makerPublicKey, 64 * 1024,
            "CORE_SINGLE_SITE_BOOTSTRAP_MAKER_PUBLIC_KEY_FILE_INVALID"),
          readBoundedPrivateFile(args.checkerAttestation, 1024 * 1024,
            "CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_ATTESTATION_FILE_INVALID"),
          readBoundedRegularFile(args.checkerPublicKey, 64 * 1024,
            "CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_PUBLIC_KEY_FILE_INVALID"),
          readBoundedRegularFile(
            required(environment, "PLATFORM_SITE_RELEASE_CERTIFICATION_KEYS_FILE"),
            256 * 1024,
            "SITE_RELEASE_CERTIFICATION_KEYS_FILE_INVALID",
          ),
        ]);
        const certificationAuthority = new Ed25519SiteReleaseCertificationAuthority(
          parseSiteReleaseCertificationKeys(parseJson(certificationKeysText,
            "SITE_RELEASE_CERTIFICATION_KEYS_FILE_INVALID")),
        );
        const execution = await prepareCoreSingleSiteBootstrapExecution({
          document,
          secretDigests: material.secretDigests,
          makerAttestations: parseCoreBootstrapAdminAttestationBundle(parseJson(
            makerBundleText,
            "CORE_SINGLE_SITE_BOOTSTRAP_MAKER_ATTESTATION_INVALID",
          )),
          makerPublicKey: publicKey(makerPublicKeyPem,
            "CORE_SINGLE_SITE_BOOTSTRAP_MAKER_PUBLIC_KEY_INVALID"),
          checkerAttestations: parseCoreBootstrapAdminAttestationBundle(parseJson(
            checkerBundleText,
            "CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_ATTESTATION_INVALID",
          )),
          checkerPublicKey: publicKey(checkerPublicKeyPem,
            "CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_PUBLIC_KEY_INVALID"),
          certificationAuthority,
          now: (input.now ?? (() => new Date().toISOString()))(),
          environment,
        });
        await connectDatabaseSet([
          databaseSet.databases.api,
          databaseSet.databases.siteWorker,
          databaseSet.databases.identityWorker,
        ]);
        const owners = await createCoreSingleSiteBootstrapProductionOwners({
          databases: databaseSet.databases,
          document,
          certificationAuthority,
          password: material.password,
          redemptionEntropySecret: material.redemptionEntropySecret,
          environment,
          ...(input.now === undefined ? {} : { clock: input.now }),
        });
        return executeCoreSingleSiteBootstrap(execution, owners);
      },
    });
    const receipt = await publishCoreSingleSiteBootstrapOutputs({
      resultPath: args.result,
      redemptionCodePath: args.redemptionCode,
      result: completed.result,
      redemptionCode: completed.redemptionCode,
      persisted: completed.persisted,
      allowCreateCode: completed.persisted.state === "available",
    });
    (input.writeStdout ?? ((value: string) => process.stdout.write(value)))(
      `${JSON.stringify(receipt)}\n`,
    );
    return receipt;
  } finally {
    await databaseSet.disconnect();
  }
}

async function publishAtomicPrivateFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, path);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await assertExistingOutput(path, content);
      return;
    }
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CORE_SINGLE_SITE_BOOTSTRAP_")) {
      throw error;
    }
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_INVALID");
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertExistingOutput(path: string, expected: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 1024 * 1024) {
      throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
    }
    const current = await handle.readFile("utf8");
    if (current !== expected) throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
  } catch (error) {
    if (error instanceof Error && error.message === "CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT") {
      throw error;
    }
    throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_OUTPUT_CONFLICT");
  } finally {
    await handle?.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function invalidArguments(): never {
  throw new Error("CORE_SINGLE_SITE_BOOTSTRAP_ARGUMENTS_INVALID");
}

function createProductionDatabaseSet(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{
  databases: CoreSingleSiteBootstrapProductionDatabases;
  disconnect(): Promise<void>;
}> {
  const roles = coreSingleSiteBootstrapDatabaseEnvironments(environment);
  const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", roles.admin));
  const api = createPlatformDatabaseClient(loadPlatformDatabaseConfig("api", roles.api));
  const siteWorker = createPlatformDatabaseClient(
    loadPlatformDatabaseConfig("site-worker", roles.siteWorker),
  );
  const identityWorker = createPlatformDatabaseClient(
    loadPlatformDatabaseConfig("identity-worker", roles.identityWorker),
  );
  const databases = Object.freeze({ admin, api, siteWorker, identityWorker });
  return Object.freeze({
    databases,
    async disconnect() {
      const outcomes = await Promise.allSettled(
        Object.values(databases).map((database) => database.disconnect()),
      );
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected");
      if (rejected.length === 1) throw rejected[0]!.reason;
      if (rejected.length > 1) {
        throw new AggregateError(rejected.map(({ reason }) => reason),
          "CORE_SINGLE_SITE_BOOTSTRAP_DATABASE_DISCONNECT_FAILED");
      }
    },
  });
}

async function connectDatabaseSet(
  databases: readonly PlatformTransactionalDatabaseClient[],
): Promise<void> {
  const connected: PlatformTransactionalDatabaseClient[] = [];
  try {
    for (const database of databases) {
      await database.connect();
      connected.push(database);
    }
  } catch (error) {
    await Promise.allSettled(connected.map((database) => database.disconnect()));
    throw error;
  }
}

function parseJson(value: string, code: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new Error(code); }
}

function publicKey(value: string, code: string) {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key;
  } catch {
    throw new Error(code);
  }
}

function required(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runCoreSingleSiteBootstrapMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform core single-Site bootstrap failed", error);
  });
}
