import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import { ActivateModelInventoryService } from "../../src/modules/model-control/application/services/activate-model-inventory.js";
import { ChangeSiteModelPolicyService } from "../../src/modules/model-control/application/services/change-site-model-policy.js";
import { ImportModelControlService } from "../../src/modules/model-control/application/services/import-model-control.js";
import { PostgresModelControlRepository } from "../../src/modules/model-control/infrastructure/postgres/model-control-repository.js";
import { PostgresModelControlCommandJournal } from "../../src/modules/model-control/infrastructure/postgres/model-control-command-journal.js";
import { verifyModelControlMigrationBundle } from "../../src/modules/model-control/migration/model-control-migration-bundle.js";
import {
  verifyRequestSecurityContext,
  type RequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/index.js";

const bundle = verifyModelControlMigrationBundle(
  JSON.parse(await readFile(argument("--bundle"), "utf8")),
);
const envelope = JSON.parse(await readFile(argument("--attestation"), "utf8")) as {
  context: RequestSecurityContext;
  signature: string;
  keyVersion: string;
};
const publicKey = createPublicKey(await readFile(argument("--public-key"), "utf8"));
const canonicalContext = Buffer.from(JSON.stringify(envelope.context));
const context = await verifyRequestSecurityContext(envelope.context, {
  now: new Date().toISOString(),
  operation: "model.bundle.import",
  expectedAudience: requiredEnv("PLATFORM_ADMIN_AUDIENCE"),
  expectedEnvironment: requiredEnv("PLATFORM_ADMIN_ENVIRONMENT"),
  expectedRegion: requiredEnv("PLATFORM_ADMIN_REGION"),
  callerVerifier: {
    verify: async (candidate) => {
      if (!verify(null, canonicalContext, publicKey, Buffer.from(envelope.signature, "base64")))
        throw new Error("MODEL_BUNDLE_ATTESTATION_INVALID");
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
const requiredOperations = [
  "model.bundle.import",
  "model.inventory.import",
  "model.inventory.activate",
  "model.site-policy.change",
];
if (
  context.trustedCaller.kind !== "admin_workload" ||
  context.target.siteId !== null ||
  context.target.purpose !== "model_control_migration" ||
  !context.target.scopes.includes("model:site-policy:migrate") ||
  requiredOperations.some(
    (operation) => !context.trustedCaller.allowedOperations.includes(operation),
  )
)
  throw new Error("MODEL_BUNDLE_MIGRATION_CONTEXT_REQUIRED");

const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
await database.connect();
try {
  const unitOfWork = new PlatformUnitOfWork(database);
  const repository = new PostgresModelControlRepository();
  const journal = new PostgresModelControlCommandJournal();
  const imported = await new ImportModelControlService(unitOfWork, repository, journal).import(
    {
      importId: bundle.importId,
      inventory: bundle.catalog,
      providerAvailability: bundle.providerAvailability,
    },
    context,
  );
  const activated = await new ActivateModelInventoryService(unitOfWork, repository, journal).activate(
    {
      activationId: bundle.activationId,
      targetDigest: bundle.catalogDigest,
      expectedPointerRevision: bundle.expectedPointerRevision,
    },
    context,
  );
  const policyService = new ChangeSiteModelPolicyService(unitOfWork, repository, journal);
  const sitePolicies = [];
  for (const command of bundle.sitePolicyCommands)
    sitePolicies.push(
      await policyService.change(
        {
          changeId: command.changeId,
          expectedRevision: command.expectedRevision,
          policy: command.policy,
        },
        context,
      ),
    );
  process.stdout.write(
    `${JSON.stringify({ bundleDigest: bundle.bundleDigest, imported, activated, sitePolicies })}\n`,
  );
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
