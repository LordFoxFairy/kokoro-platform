import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";

export async function loadVerifiedAdminContext(
  operation: string,
): Promise<VerifiedRequestSecurityContext> {
  const envelope = await readJson<{
    context: RequestSecurityContext;
    signature: string;
    keyVersion: string;
  }>(argument("--attestation"));
  const publicKey = createPublicKey(await readFile(argument("--public-key"), "utf8"));
  const canonicalContext = Buffer.from(JSON.stringify(envelope.context));
  return verifyRequestSecurityContext(envelope.context, {
    now: new Date().toISOString(),
    operation,
    expectedAudience: requiredEnv("PLATFORM_ADMIN_AUDIENCE"),
    expectedEnvironment: requiredEnv("PLATFORM_ADMIN_ENVIRONMENT"),
    expectedRegion: requiredEnv("PLATFORM_ADMIN_REGION"),
    callerVerifier: {
      verify: async (candidate) => {
        if (!verify(null, canonicalContext, publicKey, Buffer.from(envelope.signature, "base64"))) {
          throw new Error("MODEL_OPTION_ADMIN_ATTESTATION_INVALID");
        }
        return {
          workloadIdentityId: candidate.trustedCaller.workloadIdentityId,
          kind: candidate.trustedCaller.kind,
          audience: candidate.trustedCaller.audience,
          environment: candidate.trustedCaller.environment,
          region: candidate.trustedCaller.region,
          allowedOperations: candidate.trustedCaller.allowedOperations,
          siteId: candidate.trustedCaller.siteId ?? null,
          bindingEpoch: candidate.trustedCaller.bindingEpoch,
          issuedAt: candidate.trustedCaller.issuedAt,
          expiresAt: candidate.trustedCaller.expiresAt,
          issuer: candidate.evidence[0]?.issuer ?? "",
          keyVersion: envelope.keyVersion,
        };
      },
    },
  });
}

export function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`ARGUMENT_REQUIRED:${name}`);
  return value;
}

export async function readJson<Value>(path: string): Promise<Value> {
  const data = await readFile(path, "utf8");
  if (Buffer.byteLength(data, "utf8") > 4 * 1024 * 1024) {
    throw new Error("MODEL_OPTION_ADMIN_INPUT_TOO_LARGE");
  }
  return JSON.parse(data) as Value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
