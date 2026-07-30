import { createHash } from "node:crypto";
import type { HandlerContext } from "@connectrpc/connect";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  type AuthenticatedOperatorCommandContext,
  type AuthenticatedOperatorQueryContext,
  type OperatorScope,
} from "../../../../interfaces/connect/generated-admin-v2/kokoro/platform/admin/v2/admin_shared_pb.js";
import { OperatorAssuranceLevel } from
  "../../../../interfaces/connect/generated-admin-v2/kokoro/common/v2/command_envelope_pb.js";
import type { VerifiedAuthenticatedAdminAxes } from
  "../../../../interfaces/connect/generated-admin-v2/command-envelope-digest.js";
import type { VerifiedAdminWorkloadAxes } from
  "../../../../interfaces/connect/generated-admin-identity/command-envelope-digest.js";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../../../../shared/security-context/request-security-context.js";
import type { VerifiedAdminOperatorContextResolver } from
  "../../../admin-control/interfaces/connect/admin-command-service.js";
import {
  authorizeAdminOperation,
  type AuthenticatedAdminSession,
  type RequestedAdminScope,
} from "../../domain/admin-authorization.js";
import type { PostgresAdminSessionAuthenticator } from
  "../postgres/admin-session-authenticator.js";
import type {
  AdminQueryPermit,
  AdminQueryResolver,
} from "../../interfaces/connect/admin-query-service.js";
import type { AdminIdentityTransportResolver } from
  "../../interfaces/connect/admin-identity-service.js";

export interface VerifiedAdminPeer {
  readonly workloadIdentityRef: string;
  readonly environment: string;
  readonly region: string;
  readonly audience: string;
  readonly managedDeviceRef: string;
  readonly bindingEpoch: bigint;
}

export class AdminControlPlaneResolver implements
  AdminIdentityTransportResolver, VerifiedAdminOperatorContextResolver, AdminQueryResolver {
  constructor(private readonly dependencies: Readonly<{
    peer(): VerifiedAdminPeer | undefined;
    authenticator: PostgresAdminSessionAuthenticator;
    clock?: () => Date;
  }>) {}

  async resolveWorkload(
    claimed: Readonly<{
      workloadIdentityRef: string;
      environment: string;
      region: string;
      managedDeviceRef: string;
      audience: string;
    }>,
    _transport: HandlerContext,
  ): Promise<VerifiedAdminWorkloadAxes> {
    const peer = this.requirePeer();
    if (!sameWorkloadAxes(claimed, peer)) throw new Error("ADMIN_WORKLOAD_AXIS_MISMATCH");
    return Object.freeze({
      workloadIdentityRef: peer.workloadIdentityRef,
      environment: peer.environment,
      region: peer.region,
      managedDeviceRef: peer.managedDeviceRef,
      audience: peer.audience,
    });
  }

  async resolveOperator(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: "admin.identity.step-up.begin" | "admin.identity.step-up.complete" |
        "admin.identity.sign-out";
      requestedOperation?: string;
      resourceRefs?: readonly string[];
    }>,
  ) {
    const authenticated = await this.authenticate(claimed, transport);
    const scope = scopeFromWire(claimed.scope);
    if (request.operation === "admin.identity.step-up.begin") {
      if (request.requestedOperation === undefined || request.resourceRefs === undefined) {
        throw new Error("ADMIN_STEP_UP_TARGET_REQUIRED");
      }
      if (scope.kind === "site") {
        for (const siteRef of scope.siteRefs) {
          this.authorizeScope(authenticated, scope, request.requestedOperation,
            permissionFor(request.requestedOperation), siteRef,
            [siteRef, ...request.resourceRefs], [], false);
        }
      } else {
        this.authorizeScope(authenticated, scope, request.requestedOperation,
          permissionFor(request.requestedOperation), null, request.resourceRefs, [], false);
      }
    }
    return Object.freeze({
      axes: axes(authenticated.session),
      context: await this.context(
        authenticated.session, request.operation, null, scopeLabels(scope),
        claimed.command?.commandId ?? "",
      ),
    });
  }

  async resolveCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    operation: "admin.authority.change" | "admin.approval.execute",
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>> {
    const authenticated = await this.authenticate(claimed, transport);
    const requested = scopeFromWire(claimed.scope);
    const targetOperatorRef = operation === "admin.authority.change" ? undefined : undefined;
    this.authorizeScope(
      authenticated,
      requested,
      operation,
      permissionFor(operation),
      null,
      [],
      [],
      true,
      targetOperatorRef,
    );
    return Object.freeze({
      context: await this.context(
        authenticated.session, operation, null, scopeLabels(requested),
        claimed.command?.commandId ?? "",
      ),
      axes: axes(authenticated.session),
    });
  }

  async resolveQuery(
    claimed: AuthenticatedOperatorQueryContext,
    transport: HandlerContext,
    operation: "admin.receipt.read",
  ): Promise<VerifiedRequestSecurityContext> {
    const authenticated = await this.authenticate(claimed, transport);
    const requested = scopeFromWire(claimed.scope);
    this.authorizeScope(
      authenticated, requested, operation, permissionFor(operation), null, [], [], false,
    );
    return this.context(
      authenticated.session, operation, null, scopeLabels(requested), claimed.requestId,
    );
  }

  async resolve(
    claimed: AuthenticatedOperatorQueryContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: AdminQueryPermit["operation"];
      siteRef: string | null;
      resourceRefs: readonly string[];
      fieldRefs: readonly string[];
    }>,
  ): Promise<AdminQueryPermit> {
    const authenticated = await this.authenticate(claimed, transport);
    const requested = scopeFromWire(claimed.scope);
    if (requested.kind === "site" && request.siteRef === null) {
      for (const siteRef of requested.siteRefs) {
        this.authorizeScope(
          authenticated, requested, request.operation, permissionFor(request.operation),
          siteRef, [siteRef], request.fieldRefs, false,
        );
      }
    } else {
      this.authorizeScope(
        authenticated, requested, request.operation, permissionFor(request.operation),
        request.siteRef, request.resourceRefs, request.fieldRefs, false,
      );
    }
    return Object.freeze({
      operatorRef: authenticated.session.operatorRef,
      environment: authenticated.session.environment,
      region: authenticated.session.region,
      operation: request.operation,
      scope: queryScope(requested),
    });
  }

  private async authenticate(
    claimed: AuthenticatedOperatorCommandContext | AuthenticatedOperatorQueryContext,
    transport: HandlerContext,
  ) {
    const peer = this.requirePeer();
    const credential = bearerCredential(transport);
    const result = await this.dependencies.authenticator.authenticate({
      workloadIdentityRef: peer.workloadIdentityRef,
      environment: peer.environment,
      region: peer.region,
      managedDeviceRef: peer.managedDeviceRef,
      audience: peer.audience,
      credentialDigest: credentialDigest(credential),
      now: this.now().toISOString(),
    });
    if (result === null || !sameClaimedSession(claimed, result.session)) {
      throw new Error("ADMIN_SESSION_UNAUTHENTICATED");
    }
    const expectedAttestation = operatorAttestation(result.session);
    if (claimed.operatorAttestationRef !== expectedAttestation.ref ||
        claimed.operatorAttestationDigest !== expectedAttestation.digest) {
      throw new Error("ADMIN_OPERATOR_ATTESTATION_MISMATCH");
    }
    return result;
  }

  private authorizeScope(
    authenticated: NonNullable<Awaited<ReturnType<PostgresAdminSessionAuthenticator["authenticate"]>>>,
    scope: RequestedAdminScope,
    operation: string,
    permission: string,
    siteRef: string | null,
    resourceRefs: readonly string[],
    fieldRefs: readonly string[],
    mutation: boolean,
    authorityTargetOperatorRef?: string,
  ): void {
    authorizeAdminOperation({
      session: authenticated.session,
      authority: authenticated.authority,
      operation,
      requiredPermission: permission,
      scope,
      target: { siteRef, resourceRefs, fieldRefs },
      now: this.now(),
      mutation,
      ...(authorityTargetOperatorRef === undefined ? {} : { authorityTargetOperatorRef }),
    });
  }

  private async context(
    session: AuthenticatedAdminSession,
    operation: string,
    siteRef: string | null,
    scopes: readonly string[],
    requestId: string,
  ): Promise<VerifiedRequestSecurityContext> {
    const peer = this.requirePeer();
    const now = this.now();
    const expiresAt = new Date(Math.min(Date.parse(session.expiresAt), now.getTime() + 30_000));
    const issuedAt = now.toISOString();
    const caller = Object.freeze({
      workloadIdentityId: peer.workloadIdentityRef,
      kind: "admin_workload" as const,
      audience: peer.audience,
      environment: peer.environment,
      region: peer.region,
      allowedOperations: [operation],
      siteId: null,
      bindingEpoch: peer.bindingEpoch.toString(),
      issuedAt,
      expiresAt: expiresAt.toISOString(),
      issuer: "kokoro:admin-mtls-peer-registry",
      keyVersion: peer.bindingEpoch.toString(),
    });
    const request: RequestSecurityContext = {
      requestId: requestIdentifier(requestId),
      correlationId: requestIdentifier(requestId),
      trustedCaller: {
        kind: caller.kind, workloadIdentityId: caller.workloadIdentityId,
        environment: caller.environment, region: caller.region, audience: caller.audience,
        allowedOperations: caller.allowedOperations, bindingEpoch: caller.bindingEpoch,
        issuedAt: caller.issuedAt, expiresAt: caller.expiresAt,
      },
      actor: {
        kind: "operator", subjectId: session.operatorRef,
        subjectGeneration: session.operatorGeneration.toString(), sessionId: session.sessionRef,
        assuranceLevel: session.assuranceLevel, factorClasses: session.factorClasses,
        authenticatedAt: session.authenticatedAt, stepUpAt: session.stepUpAt,
        managedDeviceRef: session.managedDeviceRef, environment: session.environment,
        region: session.region, sessionEpoch: session.sessionEpoch.toString(),
        restrictionEpoch: session.restrictionEpoch.toString(),
      },
      delegatedGrant: null,
      target: { siteId: siteRef, workspaceId: null, projectId: null, purpose: operation, scopes },
      audience: caller.audience, environment: caller.environment, region: caller.region,
      evidence: [{
        kind: "mtls-workload", evidenceId: peer.workloadIdentityRef, issuer: caller.issuer,
      }],
      policyEpoch: session.policyEpoch.toString(), issuedAt, expiresAt: expiresAt.toISOString(),
    };
    return verifyRequestSecurityContext(request, {
      now: issuedAt,
      operation,
      expectedAudience: peer.audience,
      expectedEnvironment: peer.environment,
      expectedRegion: peer.region,
      callerVerifier: { verify: async () => caller },
    });
  }

  private requirePeer(): VerifiedAdminPeer {
    const peer = this.dependencies.peer();
    if (peer === undefined) throw new Error("ADMIN_VERIFIED_PEER_REQUIRED");
    return peer;
  }

  private now(): Date {
    return (this.dependencies.clock ?? (() => new Date()))();
  }
}

function bearerCredential(transport: HandlerContext): string {
  const authorization = transport.requestHeader.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    throw new Error("ADMIN_SESSION_CREDENTIAL_REQUIRED");
  }
  const credential = authorization.slice(7);
  if (credential.length < 32 || credential.length > 512 || /\s/u.test(credential)) {
    throw new Error("ADMIN_SESSION_CREDENTIAL_INVALID");
  }
  return credential;
}

function credentialDigest(value: string): string {
  return createHash("sha256").update("kokoro.admin-session-credential.v1").update("\0")
    .update(value).digest("hex");
}

export function operatorAttestation(session: AuthenticatedAdminSession): Readonly<{
  ref: string;
  digest: string;
}> {
  const ref = `admin-session:${session.sessionRef}:${session.sessionEpoch.toString()}`;
  const digest = createHash("sha256").update("kokoro.admin-operator-attestation.v1")
    .update("\0").update(JSON.stringify({
      ref, operatorRef: session.operatorRef,
      operatorGeneration: session.operatorGeneration.toString(),
      operatorSecurityEpoch: session.operatorSecurityEpoch.toString(),
      restrictionEpoch: session.restrictionEpoch.toString(),
      policyEpoch: session.policyEpoch.toString(),
      workloadIdentityRef: session.workloadIdentityRef,
      environment: session.environment, region: session.region,
      managedDeviceRef: session.managedDeviceRef, audience: session.audience,
    })).digest("hex");
  return Object.freeze({ ref, digest });
}

function sameWorkloadAxes(
  claimed: Readonly<{
    workloadIdentityRef: string;
    environment: string;
    region: string;
    managedDeviceRef: string;
    audience: string;
  }>,
  peer: VerifiedAdminPeer,
): boolean {
  return claimed.workloadIdentityRef === peer.workloadIdentityRef &&
    claimed.environment === peer.environment && claimed.region === peer.region &&
    claimed.managedDeviceRef === peer.managedDeviceRef && claimed.audience === peer.audience;
}

function sameClaimedSession(
  claimed: AuthenticatedOperatorCommandContext | AuthenticatedOperatorQueryContext,
  session: AuthenticatedAdminSession,
): boolean {
  const epochs = claimed.securityEpochs;
  if (epochs === undefined || claimed.authenticatedAt === undefined) return false;
  return claimed.operatorSessionRef === session.sessionRef && claimed.actorRef === session.operatorRef &&
    claimed.operatorGeneration === session.operatorGeneration &&
    claimed.environment === session.environment && claimed.region === session.region &&
    claimed.managedDeviceRef === session.managedDeviceRef &&
    assurance(claimed.assuranceLevel) === session.assuranceLevel &&
    sameStrings(claimed.factorClasses, session.factorClasses) &&
    timestamp(claimed.authenticatedAt) === session.authenticatedAt &&
    (claimed.stepUpAt === undefined ? null : timestamp(claimed.stepUpAt)) === session.stepUpAt &&
    epochs.operatorSecurityEpoch === session.operatorSecurityEpoch &&
    epochs.sessionEpoch === session.sessionEpoch && epochs.restrictionEpoch === session.restrictionEpoch &&
    epochs.policyEpoch === session.policyEpoch;
}

function scopeFromWire(scope: OperatorScope | undefined): RequestedAdminScope {
  if (scope === undefined || scope.kind.case === undefined) throw new Error("ADMIN_SCOPE_REQUIRED");
  if (scope.kind.case === "site") return Object.freeze({
    kind: "site", siteRefs: Object.freeze([...scope.kind.value.siteIds]),
    environment: scope.kind.value.environment, region: scope.kind.value.region,
  });
  if (scope.kind.case === "global") return Object.freeze({
    kind: "global", grantRef: scope.kind.value.grantId,
    environment: scope.kind.value.environment, region: scope.kind.value.region,
  });
  const value = scope.kind.value;
  if (value.expiresAt === undefined) throw new Error("ADMIN_BREAKGLASS_EXPIRY_REQUIRED");
  return Object.freeze({
    kind: "breakglass", grantRef: value.grantId, incidentRef: value.incidentId,
    environment: value.environment, region: value.region,
    authorizedOperation: value.authorizedOperation,
    resourceRefs: Object.freeze([...value.resourceRefs]),
    fieldAllowlist: Object.freeze([...value.fieldAllowlist]),
    expiresAt: timestamp(value.expiresAt),
  });
}

function queryScope(scope: RequestedAdminScope): AdminQueryPermit["scope"] {
  if (scope.kind === "site") return Object.freeze({ kind: "site", siteRefs: scope.siteRefs });
  if (scope.kind === "global") return Object.freeze({ kind: "global", grantRef: scope.grantRef });
  return Object.freeze({ kind: "breakglass", grantRef: scope.grantRef,
    resourceRefs: scope.resourceRefs, fieldAllowlist: scope.fieldAllowlist });
}

function scopeLabels(scope: RequestedAdminScope): readonly string[] {
  return Object.freeze([`admin:${scope.kind}`]);
}

function axes(session: AuthenticatedAdminSession): VerifiedAuthenticatedAdminAxes {
  const attestation = operatorAttestation(session);
  return Object.freeze({
    workloadIdentityRef: session.workloadIdentityRef, audience: session.audience,
    actorRef: session.operatorRef, operatorGeneration: session.operatorGeneration,
    operatorSessionRef: session.sessionRef, environment: session.environment, region: session.region,
    managedDeviceRef: session.managedDeviceRef,
    assuranceLevel: assuranceEnum(session.assuranceLevel),
    factorClasses: session.factorClasses,
    authenticatedAt: timestampFromDate(new Date(session.authenticatedAt)),
    ...(session.stepUpAt === null ? {} : { stepUpAt: timestampFromDate(new Date(session.stepUpAt)) }),
    operatorAttestationRef: attestation.ref,
    operatorAttestationDigest: attestation.digest,
  });
}

function assurance(value: OperatorAssuranceLevel): AuthenticatedAdminSession["assuranceLevel"] | null {
  if (value === OperatorAssuranceLevel.PASSWORD) return "password";
  if (value === OperatorAssuranceLevel.MFA) return "mfa";
  if (value === OperatorAssuranceLevel.PHISHING_RESISTANT) return "phishing_resistant";
  return null;
}

function assuranceEnum(value: AuthenticatedAdminSession["assuranceLevel"]): OperatorAssuranceLevel {
  if (value === "password") return OperatorAssuranceLevel.PASSWORD;
  if (value === "mfa") return OperatorAssuranceLevel.MFA;
  return OperatorAssuranceLevel.PHISHING_RESISTANT;
}

function timestamp(value: Readonly<{ seconds: bigint; nanos: number }>): string {
  return new Date(Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000)).toISOString();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) =>
    value === [...right].sort()[index]);
}

function permissionFor(operation: string): string {
  return operation === "admin.authority.change" ? "admin.authority.manage" : operation;
}

function requestIdentifier(value: string): string {
  if (value.length < 3 || value.length > 128 || Array.from(value).some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) throw new Error("ADMIN_REQUEST_ID_INVALID");
  return value;
}
