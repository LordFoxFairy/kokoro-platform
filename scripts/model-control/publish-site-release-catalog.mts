import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import type { SiteReleaseModelCatalogAdministration } from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import { createProductModelOptionAdministrationComposition } from "../../src/process/model-option-admin-composition.js";
import { argument, loadVerifiedAdminContext, readJson } from "./verified-admin-context.mjs";

type PublishInput = Parameters<SiteReleaseModelCatalogAdministration["publish"]>[0];

const context = await loadVerifiedAdminContext("model.site-release-catalog.publish");
const input = await readJson<PublishInput>(argument("--input"));
const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
await database.connect();
try {
  const composition = createProductModelOptionAdministrationComposition(database);
  const receipt = await composition.publishSiteRelease.publish(input, context);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await database.disconnect();
}
