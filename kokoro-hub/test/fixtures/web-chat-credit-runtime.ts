import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { capabilityCatalogSnapshotDigest } from "../../src/domain/capability-catalog.js";
import {
  CapabilityCatalogSnapshotSchema,
  CatalogProjectionState,
  FreezeCatalogEffectSchema,
  HubCatalogService,
} from "../../../src/generated/proto/kokoro/platform/capability/v1/capability_catalog_pb.js";
import { CommandDigestAlgorithm } from
  "../../../src/generated/proto/kokoro/common/v1/receipt_pb.js";
import { freezeCatalogRequestDigest } from "../../../src/modules/hub/interfaces/connect/capability-catalog-services.js";

const executeFile = promisify(execFile);
const PLATFORM_IDENTITY = "spiffe://kokoro.test/platform/hub-catalog/web-chat-credit-runtime";
const AGENT_IDENTITY = "spiffe://kokoro.internal/agent/web-chat-credit-runtime";

export type HubFixtureCommand = "setup" | "publish";

export type HubFixtureSetupResult = Readonly<{
  schemaVersion: 1;
  kind: "hub-web-chat-credit-runtime-setup";
  baseUrl: string;
  healthUrl: string;
  serverName: "127.0.0.1";
  trustRoot: string;
  certificateAuthorityFile: string;
  serverCertificateFile: string;
  serverPrivateKeyFile: string;
  agentCertificateFile: string;
  agentPrivateKeyFile: string;
  platformCertificateFile: string;
  platformPrivateKeyFile: string;
  peerRegistryFile: string;
  workspaceConfigFile: string;
  artifactCacheDirectory: string;
}>;

export type HubFixturePublicationResult = Readonly<{
  schemaVersion: 1;
  kind: "hub-web-chat-credit-runtime-publication";
  agentCatalogRef: string;
  projectionCommitted: true;
  replayed: boolean;
}>;

type SetupFields = Omit<HubFixtureSetupResult, "schemaVersion" | "kind">;
type PublicationFields = Omit<HubFixturePublicationResult, "schemaVersion" | "kind">;

export function parseHubFixtureCommand(args: readonly string[]): HubFixtureCommand {
  const command = args[0];
  if (args.length !== 1 || (command !== "setup" && command !== "publish")) {
    throw new Error("HUB_FIXTURE_COMMAND_INVALID");
  }
  return command;
}

export function createHubFixtureSetupResult(input: SetupFields): HubFixtureSetupResult {
  if (input.baseUrl !== `https://127.0.0.1:${new URL(input.baseUrl).port}/` ||
      input.healthUrl !== `http://127.0.0.1:${new URL(input.healthUrl).port}/` ||
      input.serverName !== "127.0.0.1") {
    throw new Error("HUB_FIXTURE_SETUP_RESULT_INVALID");
  }
  const paths = [input.trustRoot, input.certificateAuthorityFile, input.serverCertificateFile,
    input.serverPrivateKeyFile, input.agentCertificateFile, input.agentPrivateKeyFile,
    input.platformCertificateFile, input.platformPrivateKeyFile, input.peerRegistryFile,
    input.workspaceConfigFile, input.artifactCacheDirectory];
  if (paths.some((path) => !isAbsolute(path) || path.length > 4_096 || control(path))) {
    throw new Error("HUB_FIXTURE_SETUP_RESULT_INVALID");
  }
  return Object.freeze({ schemaVersion: 1, kind: "hub-web-chat-credit-runtime-setup", ...input });
}

export function createHubFixturePublicationResult(
  input: PublicationFields,
): HubFixturePublicationResult {
  if (!/^agent-catalog:sha256:[0-9a-f]{64}$/u.test(input.agentCatalogRef) ||
      input.projectionCommitted !== true || typeof input.replayed !== "boolean") {
    throw new Error("HUB_FIXTURE_PUBLICATION_RESULT_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "hub-web-chat-credit-runtime-publication",
    ...input,
  });
}

export function emptyCapabilityCatalogRef(): string {
  return `agent-catalog:sha256:${capabilityCatalogSnapshotDigest(emptySnapshot())}`;
}

export async function setupHubFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HubFixtureSetupResult> {
  const trustRoot = absolute(environment.KOKORO_HUB_FIXTURE_PRIVATE_DIR,
    "HUB_FIXTURE_PRIVATE_DIR_INVALID");
  const connectPort = port(environment.KOKORO_HUB_FIXTURE_CONNECT_PORT,
    "HUB_FIXTURE_CONNECT_PORT_INVALID");
  const healthPort = port(environment.KOKORO_HUB_FIXTURE_HEALTH_PORT,
    "HUB_FIXTURE_HEALTH_PORT_INVALID");
  if (connectPort === healthPort) throw new Error("HUB_FIXTURE_PORT_CONFLICT");
  const workspaceRoot = resolve(trustRoot, "workspace");
  const packageRoot = resolve(trustRoot, "packages");
  const artifactCacheDirectory = resolve(trustRoot, "agent-cache");
  await Promise.all([
    mkdir(trustRoot, { recursive: true, mode: 0o700 }),
    mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
    mkdir(packageRoot, { recursive: true, mode: 0o700 }),
    mkdir(artifactCacheDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const trust = await generateTrust(trustRoot);
  const peerRegistryFile = resolve(trustRoot, "hub-runtime-peers.json");
  const [platformCertificate, agentCertificate] = await Promise.all([
    readFile(trust.platformCertificateFile),
    readFile(trust.agentCertificateFile),
  ]);
  await writePrivate(peerRegistryFile, `${JSON.stringify({ version: 1, peers: [{
    sanUri: PLATFORM_IDENTITY,
    fingerprint256: new X509Certificate(platformCertificate).fingerprint256,
  }, {
    sanUri: AGENT_IDENTITY,
    fingerprint256: new X509Certificate(agentCertificate).fingerprint256,
  }] })}\n`);
  const workspaceConfigFile = resolve(trustRoot, "workspace.yaml");
  await writePrivate(workspaceConfigFile, [
    "workspace:",
    "  type: local",
    `  root: ${workspaceRoot}`,
    "hub:",
    "  type: local",
    `  root: ${packageRoot}`,
    "",
  ].join("\n"));
  return createHubFixtureSetupResult({
    baseUrl: `https://127.0.0.1:${connectPort}/`,
    healthUrl: `http://127.0.0.1:${healthPort}/`,
    serverName: "127.0.0.1",
    trustRoot,
    ...trust,
    peerRegistryFile,
    workspaceConfigFile,
    artifactCacheDirectory,
  });
}

export async function publishHubFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<HubFixturePublicationResult> {
  const baseUrl = required(environment.KOKORO_HUB_FIXTURE_BASE_URL,
    "HUB_FIXTURE_BASE_URL_REQUIRED");
  const serverName = required(environment.KOKORO_HUB_FIXTURE_SERVER_NAME,
    "HUB_FIXTURE_SERVER_NAME_REQUIRED");
  const siteId = reference(environment.KOKORO_HUB_FIXTURE_SITE_ID,
    "HUB_FIXTURE_SITE_ID_INVALID");
  const siteReleaseRef = reference(environment.KOKORO_HUB_FIXTURE_SITE_RELEASE_REF,
    "HUB_FIXTURE_SITE_RELEASE_REF_INVALID");
  const expectedCatalogRef = required(environment.KOKORO_HUB_FIXTURE_AGENT_CATALOG_REF,
    "HUB_FIXTURE_AGENT_CATALOG_REF_REQUIRED");
  if (expectedCatalogRef !== emptyCapabilityCatalogRef()) {
    throw new Error("HUB_FIXTURE_AGENT_CATALOG_REF_INVALID");
  }
  const [ca, cert, key] = await Promise.all([
    readFile(absolute(environment.KOKORO_HUB_FIXTURE_CA_FILE, "HUB_FIXTURE_CA_FILE_INVALID")),
    readFile(absolute(environment.KOKORO_HUB_FIXTURE_PLATFORM_CERT_FILE,
      "HUB_FIXTURE_PLATFORM_CERT_FILE_INVALID")),
    readFile(absolute(environment.KOKORO_HUB_FIXTURE_PLATFORM_KEY_FILE,
      "HUB_FIXTURE_PLATFORM_KEY_FILE_INVALID")),
  ]);
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "2",
    useBinaryFormat: true,
    defaultTimeoutMs: 5_000,
    readMaxBytes: 2 * 1024 * 1024,
    writeMaxBytes: 2 * 1024 * 1024,
    acceptCompression: [],
    nodeOptions: { ca, cert, key, servername: serverName, rejectUnauthorized: true,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" },
  });
  const client = createClient(HubCatalogService, transport);
  const effect = create(FreezeCatalogEffectSchema, {
    siteId,
    siteReleaseRef,
    snapshot: create(CapabilityCatalogSnapshotSchema, {
      schemaVersion: 1,
      agentOptions: [],
      tools: [],
      skillOptions: [],
      mcpOptions: [],
      subagents: [],
    }),
  });
  const requestDigest = freezeCatalogRequestDigest(effect);
  const command = {
    commandId: `web-chat-credit:${createHash("sha256").update(siteId).digest("hex").slice(0, 24)}`,
    idempotencyKey: `${siteReleaseRef}:empty-capability-catalog`,
    digestAlgorithm: CommandDigestAlgorithm.SHA256_PROTOBUF_V1,
    requestDigest,
  };
  const frozen = await client.freezeCatalog({ command, effect });
  const publicationRef = frozen.publication?.agentCatalogRef;
  if (publicationRef !== expectedCatalogRef) throw new Error("HUB_FIXTURE_PUBLICATION_INVALID");
  let projectionState = frozen.projectionState;
  const deadline = Date.now() + 20_000;
  while (projectionState !== CatalogProjectionState.COMMITTED && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    const current = await client.getCatalogPublication({
      ...command,
      siteId,
      siteReleaseRef,
    });
    if (current.publication?.agentCatalogRef !== expectedCatalogRef) {
      throw new Error("HUB_FIXTURE_PUBLICATION_CHANGED");
    }
    projectionState = current.projectionState;
  }
  if (projectionState !== CatalogProjectionState.COMMITTED) {
    throw new Error("HUB_FIXTURE_PROJECTION_NOT_COMMITTED");
  }
  return createHubFixturePublicationResult({
    agentCatalogRef: expectedCatalogRef,
    projectionCommitted: true,
    replayed: frozen.replayed,
  });
}

function emptySnapshot() {
  return Object.freeze({
    schemaVersion: 1 as const,
    agentOptions: Object.freeze([]),
    tools: Object.freeze([]),
    skillOptions: Object.freeze([]),
    mcpOptions: Object.freeze([]),
    subagents: Object.freeze([]),
  });
}

async function generateTrust(directory: string) {
  const caKey = resolve(directory, "hub-ca-key.pem");
  const certificateAuthorityFile = resolve(directory, "hub-ca.pem");
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey,
    "-out", certificateAuthorityFile, "-days", "1", "-sha256", "-subj", "/CN=Kokoro Hub Fixture CA",
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash"]);
  const server = await certificate(directory, "hub-server",
    "DNS:hub-runtime.fixture.local,IP:127.0.0.1", "serverAuth", certificateAuthorityFile, caKey);
  const agent = await certificate(directory, "hub-agent", `URI:${AGENT_IDENTITY}`,
    "clientAuth", certificateAuthorityFile, caKey);
  const platform = await certificate(directory, "hub-platform", `URI:${PLATFORM_IDENTITY}`,
    "clientAuth", certificateAuthorityFile, caKey);
  await Promise.all([chmod(caKey, 0o600), chmod(certificateAuthorityFile, 0o600)]);
  return Object.freeze({
    certificateAuthorityFile,
    serverCertificateFile: server.certificate,
    serverPrivateKeyFile: server.privateKey,
    agentCertificateFile: agent.certificate,
    agentPrivateKeyFile: agent.privateKey,
    platformCertificateFile: platform.certificate,
    platformPrivateKeyFile: platform.privateKey,
  });
}

async function certificate(
  directory: string,
  name: string,
  san: string,
  usage: "serverAuth" | "clientAuth",
  caCertificate: string,
  caKey: string,
) {
  const privateKey = resolve(directory, `${name}-key.pem`);
  const request = resolve(directory, `${name}.csr`);
  const certificatePath = resolve(directory, `${name}.pem`);
  const extensions = resolve(directory, `${name}.ext`);
  await writePrivate(extensions, ["basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment", `extendedKeyUsage=${usage}`,
    `subjectAltName=${san}`, "subjectKeyIdentifier=hash", "authorityKeyIdentifier=keyid:always", ""].join("\n"));
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", privateKey,
    "-out", request, "-subj", `/CN=${name}`, "-addext", `subjectAltName=${san}`]);
  await openssl(["x509", "-req", "-in", request, "-CA", caCertificate, "-CAkey", caKey,
    "-CAcreateserial", "-out", certificatePath, "-days", "1", "-sha256", "-extfile", extensions]);
  await Promise.all([chmod(privateKey, 0o600), chmod(certificatePath, 0o600)]);
  return Object.freeze({ privateKey, certificate: certificatePath });
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function openssl(args: readonly string[]): Promise<void> {
  try {
    await executeFile("openssl", [...args], { maxBuffer: 64 * 1024 });
  } catch {
    throw new Error("HUB_FIXTURE_TRUST_GENERATION_FAILED");
  }
}

function absolute(value: string | undefined, code: string): string {
  const path = required(value, code);
  if (!isAbsolute(path) || path.length > 4_096 || control(path)) throw new Error(code);
  return path;
}

function port(value: string | undefined, code: string): number {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 65_535) throw new Error(code);
  return parsed;
}

function reference(value: string | undefined, code: string): string {
  const result = required(value, code);
  if (result.length > 256 || result.trim() !== result || control(result)) throw new Error(code);
  return result;
}

function required(value: string | undefined, code: string): string {
  if (value === undefined || value.length < 1) throw new Error(code);
  return value;
}

function control(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  const command = parseHubFixtureCommand(process.argv.slice(2));
  const action = command === "setup" ? setupHubFixture() : publishHubFixture();
  action.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error: unknown) => {
    if (process.env.KOKORO_COMPAT_DEBUG === "1") {
      process.stderr.write(`${error instanceof Error ? error.message.slice(0, 256) : "HUB_FIXTURE_FAILED"}\n`);
    }
    process.stderr.write("HUB_FIXTURE_FAILED\n");
    process.exitCode = 1;
  });
}
