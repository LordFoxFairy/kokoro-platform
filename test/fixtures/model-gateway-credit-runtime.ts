import { execFile } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import {
  ChatCompletionRequestSchema,
  InvokeModelRequestSchema,
  ModelGatewayService,
  ModelMessageRole,
  ModelMessageSchema,
  ModelToolChoice,
} from "../../src/generated/proto/kokoro/platform/model/v1/model_gateway_pb.js";
import {
  createPostgresModelGatewayDatabase,
  loadModelGatewayDatabaseConfig,
} from "../../src/modules/model-gateway/infrastructure/postgres/model-gateway-database.js";
import { createModelGatewayProductionComposition } from
  "../../src/process/model-gateway-composition.js";
import { createPlatformModelGatewayProcess } from "../../src/process/model-gateway.js";

const executeFile = promisify(execFile);
const AGENT_IDENTITY = "spiffe://kokoro.internal/agent/web-chat-credit-runtime";
type StartupStage = "configuration-valid" | "trust-ready" | "composition-ready" |
  "runtime-starting" | "runtime-ready";

export type ModelGatewayCreditFixtureResult = Readonly<{
  schemaVersion: 1;
  kind: "model-gateway-credit-runtime";
  firstCompleted: boolean;
  replayCompleted: boolean;
  replayAttached: boolean;
  sameInvocation: boolean;
  inputTokens: number;
  outputTokens: number;
}>;

export type ModelGatewayCreditServerResult = Readonly<{
  schemaVersion: 1;
  kind: "model-gateway-credit-server";
  baseUrl: string;
  serverName: "localhost";
  certificateAuthorityFile: string;
  agentCertificateFile: string;
  agentPrivateKeyFile: string;
}>;

type ResultFields = Omit<ModelGatewayCreditFixtureResult, "schemaVersion" | "kind">;
type ServerResultFields = Omit<ModelGatewayCreditServerResult, "schemaVersion" | "kind">;

export type ModelGatewayCreditFixtureCommand = "run" | "serve";

export function parseModelGatewayCreditFixtureCommand(
  args: readonly string[],
): ModelGatewayCreditFixtureCommand {
  if (args.length === 0) return "run";
  if (args.length === 1 && args[0] === "serve") return "serve";
  throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_COMMAND_INVALID");
}

export function createModelGatewayCreditServerResult(
  input: ServerResultFields,
): ModelGatewayCreditServerResult {
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
  } catch {
    throw new Error("MODEL_GATEWAY_CREDIT_SERVER_RESULT_INVALID");
  }
  const paths = [input.certificateAuthorityFile, input.agentCertificateFile,
    input.agentPrivateKeyFile];
  if (endpoint.protocol !== "https:" || endpoint.hostname !== "127.0.0.1" ||
      endpoint.port.length === 0 || endpoint.pathname !== "/" || endpoint.search.length > 0 ||
      endpoint.hash.length > 0 || input.serverName !== "localhost" ||
      paths.some((path) => !isAbsolute(path) || path.length > 4_096 || control(path))) {
    throw new Error("MODEL_GATEWAY_CREDIT_SERVER_RESULT_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "model-gateway-credit-server",
    ...input,
  });
}

export function createModelGatewayCreditFixtureResult(input: ResultFields): ModelGatewayCreditFixtureResult {
  const flags = [input.firstCompleted, input.replayCompleted, input.replayAttached,
    input.sameInvocation];
  if (flags.some((value) => value !== true) ||
      [input.inputTokens, input.outputTokens].some((value) =>
        !Number.isSafeInteger(value) || value < 1 || value > 1_000_000)) {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_RESULT_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "model-gateway-credit-runtime",
    ...input,
  });
}

export async function startModelGatewayCreditServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<{
  result: ModelGatewayCreditServerResult;
  authorizationHandle: string;
  close(): Promise<void>;
}>> {
  const privateDirectory = absoluteDirectory(environment.PLATFORM_GATEWAY_FIXTURE_PRIVATE_DIR);
  const authorizationHandle = required(environment.PLATFORM_GATEWAY_FIXTURE_AUTHORIZATION_HANDLE,
    "PLATFORM_GATEWAY_FIXTURE_AUTHORIZATION_HANDLE");
  if (!/^model-authorization:sha256:[0-9a-f]{64}$/u.test(authorizationHandle)) {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_AUTHORIZATION_INVALID");
  }
  const port = boundedPort(environment.PLATFORM_GATEWAY_FIXTURE_PORT);
  debugStage(environment, "configuration-valid");
  const trust = await generateTrust(privateDirectory);
  debugStage(environment, "trust-ready");
  const responseKeyRingFile = resolve(privateDirectory, "response-key-ring.json");
  await writePrivateJson(responseKeyRingFile, {
    version: 1,
    currentKeyRevision: "fixture-response-key-v1",
    keys: [{
      keyRevision: "fixture-response-key-v1",
      keyBase64url: randomBytes(32).toString("base64url"),
    }],
  });
  const peersFile = resolve(privateDirectory, "model-gateway-peers.json");
  await writePrivateJson(peersFile, {
    version: 1,
    peers: [{ fingerprint256: new X509Certificate(await readFile(trust.agentCertificate)).fingerprint256,
      sanUri: AGENT_IDENTITY }],
  });
  const compositionEnvironment = Object.freeze({
    ...environment,
    PLATFORM_MODEL_GATEWAY_MTLS_PEERS_FILE: peersFile,
    PLATFORM_MODEL_GATEWAY_RESPONSE_KEY_RING_FILE: responseKeyRingFile,
    PLATFORM_MODEL_GATEWAY_AGENT_CALLER_SAN_URI: AGENT_IDENTITY,
    PLATFORM_MODEL_GATEWAY_TLS_KEY_FILE: trust.serverKey,
    PLATFORM_MODEL_GATEWAY_TLS_CERT_FILE: trust.serverCertificate,
    PLATFORM_MODEL_GATEWAY_TLS_CLIENT_CA_FILE: trust.caCertificate,
    PLATFORM_MODEL_GATEWAY_PROVIDER_TIMEOUT_MS: "10000",
    PLATFORM_MODEL_IMAGE_EFFECT_ENABLED: "false",
  });
  const database = createPostgresModelGatewayDatabase(
    loadModelGatewayDatabaseConfig(compositionEnvironment),
  );
  const composition = await createModelGatewayProductionComposition({
    database,
    environment: compositionEnvironment,
  });
  debugStage(environment, "composition-ready");
  const runtime = createPlatformModelGatewayProcess({ database, composition });
  debugStage(environment, "runtime-starting");
  const baseUrl = await runtime.start({ host: "127.0.0.1", port });
  debugStage(environment, "runtime-ready");
  return Object.freeze({
    result: createModelGatewayCreditServerResult({
      baseUrl,
      serverName: "localhost",
      certificateAuthorityFile: trust.caCertificate,
      agentCertificateFile: trust.agentCertificate,
      agentPrivateKeyFile: trust.agentKey,
    }),
    authorizationHandle,
    close: () => runtime.shutdown({ deadlineMs: 10_000 }),
  });
}

export async function runModelGatewayCreditFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ModelGatewayCreditFixtureResult> {
  const server = await startModelGatewayCreditServer(environment);
  const session = new Http2SessionManager(server.result.baseUrl, { idleConnectionTimeoutMs: 5_000 }, {
    ca: await readFile(server.result.certificateAuthorityFile),
    cert: await readFile(server.result.agentCertificateFile),
    key: await readFile(server.result.agentPrivateKeyFile),
    servername: "localhost",
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });
  try {
    const transport = createConnectTransport({
      baseUrl: server.result.baseUrl,
      httpVersion: "2",
      sessionManager: session,
      useBinaryFormat: true,
      defaultTimeoutMs: 30_000,
    });
    const client = createClient(ModelGatewayService, transport);
    const request = create(InvokeModelRequestSchema, {
      modelAuthorizationHandle: server.authorizationHandle,
      logicalCallRef: `model-call:sha256:${"1".repeat(64)}`,
      attemptRef: `model-attempt:sha256:${"2".repeat(64)}`,
      producerContext: "ga-run:web-chat-credit-runtime",
      producerGeneration: 1n,
      request: create(ChatCompletionRequestSchema, {
        protocol: "openai.chat.completions.v1",
        model: "chat-primary",
        messages: [create(ModelMessageSchema, {
          role: ModelMessageRole.USER,
          content: "compatibility",
          toolCalls: [],
        })],
        maxOutputTokens: 32,
        tools: [],
        toolChoice: ModelToolChoice.NONE,
      }),
    });
    const first = await client.invokeModel(request);
    const replay = await client.invokeModel(request);
    const firstCompleted = first.outcome.case === "completed";
    const replayCompleted = replay.outcome.case === "completed";
    const usage = first.outcome.case === "completed" ? first.outcome.value.usage : undefined;
    return createModelGatewayCreditFixtureResult({
      firstCompleted,
      replayCompleted,
      replayAttached: replay.replayed,
      sameInvocation: first.invocationRef.length > 0 && first.invocationRef === replay.invocationRef,
      inputTokens: bigintNumber(usage?.inputTokens),
      outputTokens: bigintNumber(usage?.outputTokens),
    });
  } finally {
    session.abort(new Error("MODEL_GATEWAY_CREDIT_FIXTURE_COMPLETE"));
    await server.close();
  }
}

type TrustMaterial = Readonly<{
  caCertificate: string;
  serverCertificate: string;
  serverKey: string;
  agentCertificate: string;
  agentKey: string;
}>;

async function generateTrust(directory: string): Promise<TrustMaterial> {
  const caKey = resolve(directory, "gateway-ca.key");
  const caCertificate = resolve(directory, "gateway-ca.crt");
  await openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
    "-out", caKey]);
  await openssl([
    "req", "-x509", "-new", "-key", caKey, "-sha256", "-days", "1",
    "-out", caCertificate, "-subj", "/CN=Kokoro Gateway Fixture CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash",
  ]);
  const server = await certificate(directory, "gateway-server",
    "DNS:localhost,IP:127.0.0.1", "serverAuth", caCertificate, caKey);
  const agent = await certificate(directory, "gateway-agent",
    `URI:${AGENT_IDENTITY}`, "clientAuth", caCertificate, caKey);
  await Promise.all([chmod(caKey, 0o600), chmod(caCertificate, 0o600)]);
  return Object.freeze({
    caCertificate,
    serverCertificate: server.certificate,
    serverKey: server.key,
    agentCertificate: agent.certificate,
    agentKey: agent.key,
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
  const key = resolve(directory, `${name}.key`);
  const request = resolve(directory, `${name}.csr`);
  const certificate = resolve(directory, `${name}.crt`);
  const extensions = resolve(directory, `${name}.ext`);
  await writeFile(extensions, [
    "basicConstraints=critical,CA:FALSE",
    `subjectAltName=${san}`,
    "subjectKeyIdentifier=hash",
    "authorityKeyIdentifier=keyid,issuer",
    `extendedKeyUsage=${usage}`,
    "keyUsage=digitalSignature,keyEncipherment",
    "",
  ].join("\n"), { mode: 0o600 });
  await openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
    "-out", key]);
  await openssl(["req", "-new", "-key", key, "-out", request, "-subj", `/CN=${name}`]);
  await openssl([
    "x509", "-req", "-in", request, "-CA", caCertificate, "-CAkey", caKey,
    "-CAcreateserial", "-out", certificate, "-days", "1", "-sha256", "-extfile", extensions,
  ]);
  await Promise.all([chmod(key, 0o600), chmod(certificate, 0o600)]);
  return Object.freeze({ key, certificate });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function openssl(args: readonly string[]): Promise<void> {
  try {
    await executeFile("openssl", [...args], { maxBuffer: 64 * 1024 });
  } catch {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_TRUST_FAILED");
  }
}

function absoluteDirectory(value: string | undefined): string {
  const directory = required(value, "PLATFORM_GATEWAY_FIXTURE_PRIVATE_DIR");
  if (!directory.startsWith("/") || directory.length > 4_096 || control(directory)) {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_DIRECTORY_INVALID");
  }
  return directory;
}

function boundedPort(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_PORT_INVALID");
  }
  const port = Number(value);
  if (port > 65_535) throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_PORT_INVALID");
  return port;
}

function bigintNumber(value: bigint | undefined): number {
  if (value === undefined || value < 1n || value > 1_000_000n) {
    throw new Error("MODEL_GATEWAY_CREDIT_FIXTURE_USAGE_INVALID");
  }
  return Number(value);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length < 1 || value.trim() !== value || control(value)) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function control(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}

function debugStage(
  environment: Readonly<Record<string, string | undefined>>,
  stage: StartupStage,
): void {
  if (environment.KOKORO_COMPAT_DEBUG === "1") {
    process.stderr.write(`MODEL_GATEWAY_CREDIT_FIXTURE_STAGE:${stage}\n`);
  }
}

function isMainModule(): boolean {
  return typeof process.argv[1] === "string" &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

function waitForTermination(): Promise<void> {
  return new Promise((resolveTermination) => {
    const complete = () => {
      process.off("SIGTERM", complete);
      process.off("SIGINT", complete);
      resolveTermination();
    };
    process.once("SIGTERM", complete);
    process.once("SIGINT", complete);
  });
}

export async function serveModelGatewayCreditFixture(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const server = await startModelGatewayCreditServer(environment);
  try {
    process.stdout.write(`${JSON.stringify(server.result)}\n`);
    await waitForTermination();
  } finally {
    await server.close();
  }
}

async function runCli(): Promise<void> {
  const command = parseModelGatewayCreditFixtureCommand(process.argv.slice(2));
  if (command === "serve") {
    await serveModelGatewayCreditFixture();
    return;
  }
  const result = await runModelGatewayCreditFixture();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (isMainModule()) {
  runCli().catch((error: unknown) => {
    if (process.env.KOKORO_COMPAT_DEBUG === "1") {
      const name = error instanceof Error ? error.name : typeof error;
      const message = error instanceof Error ? error.message.slice(0, 256) : "unknown";
      process.stderr.write(`MODEL_GATEWAY_CREDIT_FIXTURE_DEBUG:${name}:${message}\n`);
    }
    process.stderr.write("MODEL_GATEWAY_CREDIT_FIXTURE_FAILED\n");
    process.exitCode = 1;
  });
}
