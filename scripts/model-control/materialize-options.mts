import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import type { ModelOptionMaterializationAdministration } from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import { createProductModelOptionAdministrationComposition } from "../../src/process/model-option-admin-composition.js";
import { argument, loadVerifiedAdminContext, readJson } from "./verified-admin-context.mjs";

type MaterializeInput = Parameters<ModelOptionMaterializationAdministration["materialize"]>[0];

const context = await loadVerifiedAdminContext("model.option.materialize");
const input = await readJson<MaterializeInput>(argument("--input"));
const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
await database.connect();
try {
  const composition = createProductModelOptionAdministrationComposition(database);
  const receipt = await composition.materialize.materialize(input, context);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await database.disconnect();
}
