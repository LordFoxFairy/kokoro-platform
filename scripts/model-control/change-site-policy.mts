import { readFile } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import { ChangeSiteModelPolicyService } from "../../src/modules/model-control/application/services/change-site-model-policy.js";
import { PostgresModelControlRepository } from "../../src/modules/model-control/infrastructure/postgres/model-control-repository.js";
import { PostgresModelControlCommandJournal } from "../../src/modules/model-control/infrastructure/postgres/model-control-command-journal.js";
import type { SiteModelPolicy } from "../../src/modules/model-control/domain/site-model-policy.js";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/index.js";

const policy = JSON.parse(await readFile(argument("--policy"), "utf8")) as SiteModelPolicy;
const envelope = JSON.parse(await readFile(argument("--attestation"), "utf8")) as {
  context: RequestSecurityContext;
  signature: string;
  keyVersion: string;
};
const publicKey = createPublicKey(await readFile(argument("--public-key"), "utf8"));
const canonicalContext = Buffer.from(JSON.stringify(envelope.context));
const context = await verifyRequestSecurityContext(envelope.context, {
  now: new Date().toISOString(),
  operation: "model.site-policy.change",
  expectedAudience: requiredEnv("PLATFORM_ADMIN_AUDIENCE"),
  expectedEnvironment: requiredEnv("PLATFORM_ADMIN_ENVIRONMENT"),
  expectedRegion: requiredEnv("PLATFORM_ADMIN_REGION"),
  callerVerifier: {
    verify: async (candidate) => {
      if (!verify(null, canonicalContext, publicKey, Buffer.from(envelope.signature, "base64")))
        throw new Error("MODEL_SITE_POLICY_ATTESTATION_INVALID");
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
const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
await database.connect();
try {
  const receipt = await new ChangeSiteModelPolicyService(
    new PlatformUnitOfWork(database),
    new PostgresModelControlRepository(),
    new PostgresModelControlCommandJournal(),
  ).change(
    {
      changeId: argument("--change-id"),
      expectedRevision: argument("--expected-revision"),
      policy,
    },
    context,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await database.disconnect();
}
function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`ARGUMENT_REQUIRED:${name}`);
  return value;
}
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
