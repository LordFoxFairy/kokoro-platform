import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionAuthenticationPort, SessionAccessGrantSigner } from "../../modules/authorization/application/contracts/session-authorization-ports.js";
import { credentialDigest } from "../../modules/authorization/application/contracts/authorization-digest.js";
import {
  SessionAuthorizationError,
  type AuthenticatedUserSession,
  type ProductWorkloadIdentity,
} from "../../modules/authorization/domain/session-access-grant.js";
import { ProductWorkloadRegistry } from "../../modules/authorization/infrastructure/transport/product-workload-registry.js";
import type { VerifiedCsrfEvidence } from "../../modules/authorization/infrastructure/transport/product-workload-registry.js";
import { IdentityApplicationError } from "../../modules/identity/application/services/identity-application-service.js";
import { CommerceApplicationError } from "../../modules/commerce/application/commerce-application-error.js";
import { verifyRequestSecurityContext, type VerifiedRequestSecurityContext } from "../../shared/security-context/request-security-context.js";
import {
  createPlatformPublicOperationRegistry,
  type PlatformPublicOperationExecution,
  type RegisteredPlatformPublicOperation,
} from "./platform-public-operation-registry.js";
import type { PlatformPublicOperationId } from "./generated/platform-public/operations.gen.js";
import type { ErrorCode, ErrorResponse } from "./generated/platform-public/types.gen.js";

export interface PlatformPublicHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createPlatformPublicHttpHandler(input: Readonly<{
  workloads: ProductWorkloadRegistry;
  sessions: SessionAuthenticationPort;
  operations: readonly RegisteredPlatformPublicOperation[];
  requiredOperationIds: readonly PlatformPublicOperationId[];
  grantSigner: SessionAccessGrantSigner;
  sessionCredentialDigest?: (credential: string) => string;
  clock?: () => Date;
}>): PlatformPublicHttpHandler {
  const clock = input.clock ?? (() => new Date());
  const sessionCredentialDigest = input.sessionCredentialDigest ?? credentialDigest;
  const registry = createPlatformPublicOperationRegistry(input.operations, input.requiredOperationIds);
  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const requestId = randomUUID();
      const correlationId = randomUUID();
      let target: PlatformPublicRequestTarget;
      try {
        target = parsePlatformPublicRequestTarget(request.url);
      } catch (error) {
        response.setHeader("x-request-id", requestId);
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        const problem = platformPublicSafeProblem(error, requestId, correlationId);
        response.statusCode = problem.status;
        response.setHeader("content-type", "application/problem+json; charset=utf-8");
        response.end(JSON.stringify(problem.body));
        return true;
      }
      if (request.method === "GET" && target.pathname === "/.well-known/kokoro-session-access-jwks.json") {
        response.setHeader("x-request-id", requestId);
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        if (Object.keys(target.query).length !== 0) {
          const problem = platformPublicSafeProblem(new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID"), requestId, correlationId);
          sendProblem(response, problem);
          return true;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/jwk-set+json; charset=utf-8");
        response.setHeader("cache-control", "public, max-age=300, must-revalidate");
        response.setHeader("x-content-type-options", "nosniff");
        response.end(JSON.stringify(input.grantSigner.jwks()));
        return true;
      }
      const matched = registry.match(request.method, target.pathname);
      if (matched === null) return false;
      response.setHeader("x-request-id", requestId);
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      try {
        const workload = input.workloads.authenticate(request, matched.descriptor.operationId);
        const now = instant(clock());
        const headers = parseOptional(matched.definition.requestSchemas.headers, requestHeaders(request));
        const body = matched.definition.requestSchemas.body === null
          ? null
          : requestValue(matched.definition.requestSchemas.body as RuntimeSchema, await readJsonBody(request));
        const pathParameters = parseOptional(matched.definition.requestSchemas.path, matched.path);
        const query = matched.definition.requestSchemas.query === null
          ? noQuery(target.query)
          : requestValue(matched.definition.requestSchemas.query as RuntimeSchema, target.query);
        const csrfEvidence = matched.definition.mutation
          ? input.workloads.verifyCsrfEvidence(workload, header(request, "x-csrf-token"))
          : null;
        if (matched.definition.mutation && csrfEvidence === null) {
          throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
        }
        const sessionRequired = matched.definition.securityAlternatives.every((alternative) =>
          alternative.includes("UserSession"));
        const session = sessionRequired
          ? await authenticateSession(input.sessions, request, workload, now, sessionCredentialDigest)
          : null;
        const receiptRecoveryCapability = matched.definition.receiptRecovery === "required"
          ? recoveryCapability(request)
          : null;
        const projectRef = targetProjectRef(matched.descriptor, body, pathParameters);
        const context = await buildPlatformPublicRequestSecurityContext({
          workload, session, operation: matched.descriptor.operationId,
          requestId, correlationId, now, projectRef, registry: input.workloads, csrfEvidence,
        });
        const execution = {
          operationId: matched.descriptor.operationId,
          workload, session, context, headers, body, path: pathParameters, query,
          receiptRecoveryCapability,
        } as PlatformPublicOperationExecution<PlatformPublicOperationId>;
        const result = await matched.descriptor.execute(execution);
        const responseBody = requestValue(matched.definition.responseSchema as RuntimeSchema, result);
        const successStatus = matched.definition.successStatuses[0];
        if (successStatus === undefined) throw new Error("PLATFORM_PUBLIC_SUCCESS_STATUS_MISSING");
        sendJson(response, successStatus, responseBody);
        return true;
      } catch (error) {
        sendProblem(response, platformPublicSafeProblem(error, requestId, correlationId));
        return true;
      }
    },
  });
}

function targetProjectRef(
  descriptor: RegisteredPlatformPublicOperation,
  body: unknown,
  path: unknown,
): string | null {
  const resolver = descriptor.targetProjectRef as ((input: Readonly<{ body: unknown; path: unknown }>) => string | null) | undefined;
  return resolver?.({ body, path }) ?? null;
}

export type PlatformPublicRequestTarget = Readonly<{
  pathname: string;
  query: Readonly<Record<string, string>>;
}>;

export function parsePlatformPublicRequestTarget(raw: string | undefined): PlatformPublicRequestTarget {
  if (
    raw === undefined || raw.length < 1 || raw.length > 8_192 ||
    !raw.startsWith("/") || raw.startsWith("//") || raw.includes("#") ||
    /%(?![0-9a-f]{2})/iu.test(raw)
  ) throw new Error("PLATFORM_PUBLIC_REQUEST_TARGET_INVALID");
  const queryOffset = raw.indexOf("?");
  const rawPathname = queryOffset < 0 ? raw : raw.slice(0, queryOffset);
  let parsed: URL;
  try { parsed = new URL(raw, "https://platform.invalid"); }
  catch { throw new Error("PLATFORM_PUBLIC_REQUEST_TARGET_INVALID"); }
  if (
    parsed.origin !== "https://platform.invalid" || parsed.username !== "" || parsed.password !== "" ||
    parsed.pathname !== rawPathname || parsed.pathname.length > 2_048 || parsed.pathname.includes("\uFFFD")
  ) throw new Error("PLATFORM_PUBLIC_REQUEST_TARGET_INVALID");
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const [name, value] of parsed.searchParams) {
    if (
      entries.length >= 32 || names.has(name) || name.length < 1 || name.length > 128 ||
      value.length > 2_048 || name.includes("\uFFFD") || value.includes("\uFFFD") ||
      hasControlCharacter(name) || hasControlCharacter(value)
    ) throw new Error("PLATFORM_PUBLIC_REQUEST_TARGET_INVALID");
    names.add(name);
    entries.push([name, value]);
  }
  return Object.freeze({ pathname: parsed.pathname, query: Object.freeze(Object.fromEntries(entries)) });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function noQuery(query: Readonly<Record<string, string>>): null {
  if (Object.keys(query).length !== 0) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  return null;
}

const PUBLIC_HEADER_NAMES = Object.freeze([
  "Kokoro-Contract-Version", "X-Kokoro-Command-Id", "Idempotency-Key", "X-CSRF-Token",
] as const);

function requestHeaders(request: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PUBLIC_HEADER_NAMES) {
    const value = request.headers[name.toLowerCase()];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function recoveryCapability(request: IncomingMessage): string {
  const value = header(request, "x-kokoro-receipt-recovery-capability");
  if (
    value === undefined || value.length < 32 || value.length > 2048 ||
    value.trim() !== value || /\s/u.test(value)
  ) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  return value;
}

async function authenticateSession(
  sessions: SessionAuthenticationPort,
  request: IncomingMessage,
  workload: ProductWorkloadIdentity,
  now: string,
  digest: (credential: string) => string,
): Promise<AuthenticatedUserSession> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  }
  const credential = authorization.slice(7);
  if (
    credential.length < 32 || credential.length > 2048 || credential.trim() !== credential ||
    [...credential].some((character) => (character.codePointAt(0) ?? 0) <= 32)
  ) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  let credentialDigestValue: string;
  try { credentialDigestValue = digest(credential); }
  catch { throw new SessionAuthorizationError("USER_SESSION_REQUIRED"); }
  const session = await sessions.authenticateUserSession({
    credentialDigest: credentialDigestValue, siteRef: workload.siteRef, now,
  });
  if (session === null) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  return session;
}

export async function buildPlatformPublicRequestSecurityContext(input: Readonly<{
  workload: ProductWorkloadIdentity;
  session: AuthenticatedUserSession | null;
  operation: PlatformPublicOperationId;
  requestId: string;
  correlationId: string;
  now: string;
  projectRef: string | null;
  registry: ProductWorkloadRegistry;
  csrfEvidence: VerifiedCsrfEvidence | null;
}>): Promise<VerifiedRequestSecurityContext> {
  const expiresAt = instant(new Date(Date.parse(input.now) + 60_000));
  const actor = input.session === null
    ? { kind: "anonymous" as const, subjectId: "anonymous", subjectGeneration: "1" }
    : {
        kind: "user" as const,
        subjectId: input.session.subjectRef,
        subjectGeneration: input.session.subjectGeneration,
        sessionId: input.session.identitySessionRef,
        assuranceLevel: input.session.authenticationMethods.includes("totp") ? "mfa" as const : "password" as const,
        factorClasses: input.session.authenticationMethods,
        authenticatedAt: input.session.authenticatedAt,
        sessionEpoch: input.session.identitySessionEpoch,
        restrictionEpoch: input.session.restrictionEpoch,
      };
  return verifyRequestSecurityContext({
    requestId: input.requestId,
    correlationId: input.correlationId,
    trustedCaller: {
      kind: "site_product",
      workloadIdentityId: input.workload.workloadIdentityId,
      siteId: input.workload.siteRef,
      siteReleaseRef: input.workload.siteReleaseRef,
      environment: input.workload.environment,
      region: input.workload.region,
      audience: input.workload.audience,
      allowedOperations: input.workload.allowedOperations,
      bindingEpoch: input.workload.bindingEpoch,
      siteSecurityEpoch: input.workload.siteSecurityEpoch,
      issuedAt: input.now,
      expiresAt,
    },
    actor,
    delegatedGrant: null,
    target: {
      siteId: input.workload.siteRef,
      workspaceId: null,
      projectId: input.projectRef,
      purpose: input.operation,
      scopes: [input.operation],
    },
    audience: input.workload.audience,
    environment: input.workload.environment,
    region: input.workload.region,
    evidence: [
      {
        kind: "mtls-certificate-sha256",
        evidenceId: input.workload.certificateSha256,
        issuer: "kokoro-platform-product-workload-registry",
      },
      ...(input.csrfEvidence === null ? [] : [{
        kind: "csrf_verification",
        evidenceId: input.registry.verifiedCsrfDigest(input.workload, input.csrfEvidence),
        issuer: "kokoro-platform-public",
      }]),
      ...(input.session === null ? [] : [{
        kind: "opaque-user-session-digest",
        evidenceId: input.session.identitySessionRef,
        issuer: "kokoro-platform-identity-session",
      }]),
    ],
    policyEpoch: input.workload.policyEpoch,
    issuedAt: input.now,
    expiresAt,
  }, {
    now: input.now,
    operation: input.operation,
    expectedAudience: input.workload.audience,
    expectedEnvironment: input.workload.environment,
    expectedRegion: input.workload.region,
    callerVerifier: input.registry,
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  const declaredHeader = request.headers["content-length"];
  if (declaredHeader !== undefined) {
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > 65_536) {
      throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 65_536) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID"); }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function sendProblem(
  response: ServerResponse,
  problem: Readonly<{ status: number; body: ErrorResponse }>,
): void {
  response.statusCode = problem.status;
  response.setHeader("content-type", "application/problem+json; charset=utf-8");
  response.end(JSON.stringify(problem.body));
}

export function platformPublicSafeProblem(error: unknown, requestId: string, correlationId: string): { status: number; body: ErrorResponse } {
  let status = 503;
  let code: ErrorCode = "INTERNAL_UNAVAILABLE";
  let retryClass: ErrorResponse["retryClass"] = "after_delay";
  let safeMessage = "The service is temporarily unavailable.";
  const authorizationCode = error instanceof SessionAuthorizationError ? error.code : undefined;
  if (error instanceof CommerceApplicationError) {
    if (error.code === "REDEEM_NOT_ACCEPTED") {
      status = 422; code = "REDEEM_NOT_ACCEPTED"; retryClass = "never";
      safeMessage = "The redemption was not accepted.";
    } else {
      status = 503; code = "REDEEM_TEMPORARILY_UNAVAILABLE"; retryClass = "after_delay";
      safeMessage = "Redemption is temporarily unavailable.";
    }
  } else if (authorizationCode === "USER_SESSION_REQUIRED" || (error instanceof IdentityApplicationError && error.code === "AUTHENTICATION_FAILED")) {
    status = 401; code = authorizationCode === "USER_SESSION_REQUIRED" ? "AUTHENTICATION_REQUIRED" : "AUTHENTICATION_FAILED";
    retryClass = "after_user_action"; safeMessage = "Authentication failed.";
  } else if (authorizationCode === "WORKLOAD_NOT_AUTHORIZED" || authorizationCode === "PROJECT_NOT_AUTHORIZED") {
    status = 404; code = "NOT_FOUND"; retryClass = "never"; safeMessage = "The requested resource was not found.";
  } else if (
    authorizationCode === "AUTHORIZATION_INPUT_INVALID" || error instanceof SyntaxError ||
    (error instanceof Error && error.message === "PLATFORM_PUBLIC_REQUEST_TARGET_INVALID") ||
    (error instanceof IdentityApplicationError && error.code === "AUTH_TRANSACTION_INVALID")
  ) {
    status = 400; code = error instanceof IdentityApplicationError ? "AUTH_TRANSACTION_EXPIRED" : "INVALID_REQUEST";
    retryClass = "never"; safeMessage = "The request is invalid.";
  } else if (authorizationCode === "PRODUCT_CONTEXT_STALE" || authorizationCode === "AUTHORIZATION_STALE") {
    status = 503; code = "SITE_UNAVAILABLE"; retryClass = "after_delay"; safeMessage = "The site is temporarily unavailable.";
  } else if (
    error instanceof Error &&
    (error.message.includes("COMMAND_DIGEST_CONFLICT") || error.message.includes("COMMAND_IDENTITY_CONFLICT"))
  ) {
    status = 409; code = "IDEMPOTENCY_CONFLICT"; retryClass = "never"; safeMessage = "The command identity conflicts with an earlier request.";
  }
  return { status, body: Object.freeze({ code, retryClass, requestId, correlationId, safeMessage }) };
}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}

interface RuntimeSchema<Output = unknown> { parse(value: unknown): Output }

function requestValue<Output>(schema: RuntimeSchema<Output>, value: unknown): Output {
  try { return schema.parse(value); }
  catch { throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID"); }
}

function parseOptional(schema: RuntimeSchema | null, value: unknown): unknown {
  return schema === null ? null : requestValue(schema, value);
}
