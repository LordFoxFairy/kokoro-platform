import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionAuthenticationPort, SessionAccessGrantSigner } from "../../modules/authorization/application/contracts/session-authorization-ports.js";
import { credentialDigest } from "../../modules/authorization/application/contracts/authorization-digest.js";
import type { ExchangeProductContextService } from "../../modules/authorization/application/services/exchange-product-context.js";
import type { GetPersonalContextService } from "../../modules/authorization/application/services/get-personal-context.js";
import type { IssueSessionAccessGrantService } from "../../modules/authorization/application/services/issue-session-access-grant.js";
import {
  SessionAuthorizationError,
  type AuthenticatedUserSession,
  type ProductWorkloadIdentity,
  type SessionAccessPurpose,
  type SessionGrantResource,
} from "../../modules/authorization/domain/session-access-grant.js";
import { ProductWorkloadRegistry } from "../../modules/authorization/infrastructure/transport/product-workload-registry.js";
import type { VerifiedCsrfEvidence } from "../../modules/authorization/infrastructure/transport/product-workload-registry.js";
import { verifyRequestSecurityContext, type VerifiedRequestSecurityContext } from "../../shared/security-context/request-security-context.js";
import {
  zExchangeProductContextBody,
  zExchangeProductContextHeaders,
  zExchangeProductContextResponse,
  zGetPersonalContextHeaders,
  zGetPersonalContextResponse,
  zIssueSessionAccessGrantBody,
  zIssueSessionAccessGrantHeaders,
  zIssueSessionAccessGrantResponse,
} from "./generated/platform-public/zod.gen.js";
import type { ErrorCode, ErrorResponse } from "./generated/platform-public/types.gen.js";

export interface PlatformPublicHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createPlatformPublicHttpHandler(input: Readonly<{
  workloads: ProductWorkloadRegistry;
  sessions: SessionAuthenticationPort;
  exchangeProductContext: ExchangeProductContextService;
  getPersonalContext: GetPersonalContextService;
  issueSessionAccessGrant: IssueSessionAccessGrantService;
  grantSigner: SessionAccessGrantSigner;
  clock?: () => Date;
}>): PlatformPublicHttpHandler {
  const clock = input.clock ?? (() => new Date());
  return Object.freeze({
    async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      const path = exactPath(request.url);
      if (request.method === "GET" && path === "/.well-known/kokoro-session-access-jwks.json") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/jwk-set+json; charset=utf-8");
        response.setHeader("cache-control", "public, max-age=300, must-revalidate");
        response.setHeader("x-content-type-options", "nosniff");
        response.end(JSON.stringify(input.grantSigner.jwks()));
        return true;
      }
      const operation = matchOperation(request.method, path);
      if (operation === null) return false;
      const requestId = randomUUID();
      const correlationId = randomUUID();
      response.setHeader("x-request-id", requestId);
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      try {
        const workload = input.workloads.authenticate(request, operation);
        const now = instant(clock());
        let session: AuthenticatedUserSession | null = null;
        if (operation === "exchangeProductContext") {
          const headers = requestValue(zExchangeProductContextHeaders, mutationHeaders(request));
          const csrfEvidence = input.workloads.verifyCsrfEvidence(workload, headers["X-CSRF-Token"]);
          if (csrfEvidence === null) {
            throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
          }
          const commandBody = requestValue(zExchangeProductContextBody, await readJsonBody(request));
          const context = await buildPlatformPublicRequestSecurityContext({ workload, session: null, operation, requestId, correlationId, now, projectRef: null, registry: input.workloads, csrfEvidence });
          const result = await input.exchangeProductContext.execute({
            workload,
            context,
            commandId: headers["X-Kokoro-Command-Id"],
            idempotencyKey: headers["Idempotency-Key"],
            commandRef: commandBody.commandRef,
          });
          sendJson(response, 200, zExchangeProductContextResponse.parse({
            receipt: result.receipt,
            context: result.context,
          }));
          return true;
        }
        if (operation === "getPersonalContext") {
          requestValue(zGetPersonalContextHeaders, readHeaders(request, ["Kokoro-Contract-Version"]));
          session = await authenticateSession(input.sessions, request, workload, now);
          const context = await buildPlatformPublicRequestSecurityContext({ workload, session, operation, requestId, correlationId, now, projectRef: null, registry: input.workloads, csrfEvidence: null });
          const result = await input.getPersonalContext.execute({ workload, session, context });
          sendJson(response, 200, zGetPersonalContextResponse.parse(result));
          return true;
        }
        const headers = requestValue(zIssueSessionAccessGrantHeaders, mutationHeaders(request, false));
        const csrfEvidence = input.workloads.verifyCsrfEvidence(workload, headers["X-CSRF-Token"]);
        if (csrfEvidence === null) {
          throw new SessionAuthorizationError("WORKLOAD_NOT_AUTHORIZED");
        }
        const grantInput = requestValue(zIssueSessionAccessGrantBody, await readJsonBody(request));
        session = await authenticateSession(input.sessions, request, workload, now);
        const context = await buildPlatformPublicRequestSecurityContext({
          workload,
          session,
          operation,
          requestId,
          correlationId,
          now,
          projectRef: grantInput.projectRef,
          registry: input.workloads,
          csrfEvidence,
        });
        const grant = await input.issueSessionAccessGrant.execute({
          workload,
          session,
          context,
          productContextRef: grantInput.productContextRef,
          projectRef: grantInput.projectRef,
          purpose: grantInput.purpose as SessionAccessPurpose,
          resource: grantInput.resource as SessionGrantResource,
        });
        sendJson(response, 201, zIssueSessionAccessGrantResponse.parse({ grant }));
        return true;
      } catch (error) {
        const problem = safeProblem(error, requestId, correlationId);
        response.statusCode = problem.status;
        response.setHeader("content-type", "application/problem+json; charset=utf-8");
        response.end(JSON.stringify(problem.body));
        return true;
      }
    },
  });
}

type Operation = "exchangeProductContext" | "getPersonalContext" | "issueSessionAccessGrant";

function matchOperation(method: string | undefined, path: string): Operation | null {
  if (method === "POST" && path === "/v1/product-context:exchange") return "exchangeProductContext";
  if (method === "GET" && path === "/v1/me/personal-context") return "getPersonalContext";
  if (method === "POST" && path === "/v1/session-access-grants") return "issueSessionAccessGrant";
  return null;
}

function exactPath(raw: string | undefined): string {
  if (raw === undefined || !raw.startsWith("/") || raw.includes("#")) return "";
  const query = raw.indexOf("?");
  if (query >= 0 && raw.slice(query + 1) !== "") return "";
  return query < 0 ? raw : raw.slice(0, query);
}

function readHeaders(request: IncomingMessage, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => {
    const value = request.headers[name.toLowerCase()];
    if (typeof value !== "string") throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
    return [name, value];
  }));
}

function mutationHeaders(request: IncomingMessage, command = true): Record<string, string> {
  return readHeaders(request, command
    ? ["Kokoro-Contract-Version", "X-Kokoro-Command-Id", "Idempotency-Key", "X-CSRF-Token"]
    : ["Kokoro-Contract-Version", "X-CSRF-Token"]);
}

async function authenticateSession(
  sessions: SessionAuthenticationPort,
  request: IncomingMessage,
  workload: ProductWorkloadIdentity,
  now: string,
): Promise<AuthenticatedUserSession> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  }
  const credential = authorization.slice(7);
  if (
    credential.length < 32 || credential.length > 4096 || credential.trim() !== credential ||
    [...credential].some((character) => (character.codePointAt(0) ?? 0) <= 32)
  ) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  const session = await sessions.authenticateUserSession({
    credentialDigest: credentialDigest(credential),
    siteRef: workload.siteRef,
    now,
  });
  if (session === null) throw new SessionAuthorizationError("USER_SESSION_REQUIRED");
  return session;
}

export async function buildPlatformPublicRequestSecurityContext(input: Readonly<{
  workload: ProductWorkloadIdentity;
  session: AuthenticatedUserSession | null;
  operation: Operation;
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
  const declared = Number(request.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > 65_536) {
    throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 65_536) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function safeProblem(error: unknown, requestId: string, correlationId: string): { status: number; body: ErrorResponse } {
  let status = 503;
  let code: ErrorCode = "INTERNAL_UNAVAILABLE";
  let retryClass: ErrorResponse["retryClass"] = "after_delay";
  let safeMessage = "The service is temporarily unavailable.";
  const authorizationCode = error instanceof SessionAuthorizationError ? error.code : undefined;
  if (authorizationCode === "USER_SESSION_REQUIRED") {
    status = 401; code = "AUTHENTICATION_REQUIRED"; retryClass = "after_user_action";
    safeMessage = "Authentication is required.";
  } else if (authorizationCode === "WORKLOAD_NOT_AUTHORIZED" || authorizationCode === "PROJECT_NOT_AUTHORIZED") {
    status = 404; code = "NOT_FOUND"; retryClass = "never"; safeMessage = "The requested resource was not found.";
  } else if (authorizationCode === "AUTHORIZATION_INPUT_INVALID" || error instanceof SyntaxError) {
    status = 400; code = "INVALID_REQUEST"; retryClass = "never"; safeMessage = "The request is invalid.";
  } else if (authorizationCode === "PRODUCT_CONTEXT_STALE" || authorizationCode === "AUTHORIZATION_STALE") {
    status = 503; code = "SITE_UNAVAILABLE"; retryClass = "after_delay"; safeMessage = "The site is temporarily unavailable.";
  } else if (
    error instanceof Error &&
    (error.message.includes("COMMAND_DIGEST_CONFLICT") || error.message.includes("COMMAND_IDENTITY_CONFLICT"))
  ) {
    status = 409; code = "IDEMPOTENCY_CONFLICT"; retryClass = "never"; safeMessage = "The command identity conflicts with an earlier request.";
  }
  return {
    status,
    body: Object.freeze({ code, retryClass, requestId, correlationId, safeMessage }),
  };
}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}

interface RuntimeSchema<Output> {
  parse(value: unknown): Output;
}

function requestValue<Output>(schema: RuntimeSchema<Output>, value: unknown): Output {
  try {
    return schema.parse(value);
  } catch {
    throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  }
}
