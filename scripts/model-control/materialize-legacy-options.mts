import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import type { LegacyModelOptionMigrationArtifact } from "../../src/modules/model-control/migration/legacy-model-option-artifact.js";
import { createProductModelOptionAdministrationComposition } from "../../src/process/model-option-admin-composition.js";
import { argument, loadVerifiedAdminContext, readJson } from "./verified-admin-context.mjs";

const context = await loadVerifiedAdminContext("model.option.migration.materialize");
const artifact = await readJson<LegacyModelOptionMigrationArtifact>(argument("--artifact"));
const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
await database.connect();
try {
  const composition = createProductModelOptionAdministrationComposition(database);
  const receipt = await composition.materializeLegacy.materialize(
    {
      materializationId: argument("--materialization-id"),
      inventoryDigest: argument("--inventory-digest"),
      artifact,
    },
    context,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await database.disconnect();
}
