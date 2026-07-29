import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../infrastructure/postgres/client.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCommerceAdministrationComposition } from "./commerce-admin-composition.js";
import { createPlatformSiteAdminComposition } from "./site-admin-composition.js";

/** Dedicated control-plane host. It never shares the public API database credential. */
export async function runPlatformAdminMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
  await createCommerceAdministrationComposition({ database });
  const composition = createPlatformSiteAdminComposition(database);
  const process = composition.process;
  const port = Number.parseInt(globalThis.process.env.PLATFORM_ADMIN_PORT ?? "4101", 10);
  await process.start({ host: "0.0.0.0", port });
  const shutdown = () => process.shutdown().finally(() => globalThis.process.exit());
  globalThis.process.once("SIGTERM", shutdown);
  globalThis.process.once("SIGINT", shutdown);
}

const entry = globalThis.process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  runPlatformAdminMain().catch((error: unknown) => {
    globalThis.process.exitCode = 1;
    console.error("Platform admin failed", error);
  });
}
