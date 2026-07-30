import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../infrastructure/postgres/client.js";
import { createAdminProductionComposition } from "./admin-composition.js";
import { createPlatformAdmissionProcess } from "./admission.js";

/**
 * Single production Admin control-plane deployable. Identity, Query and Command
 * share one mTLS listener and one least-privilege Admin database pool.
 */
export async function runPlatformAdminMain(): Promise<void> {
  const database = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin"));
  const composition = await createAdminProductionComposition({ database });
  const processHost = createPlatformAdmissionProcess({ database, composition });
  const port = parsePort(process.env.PLATFORM_ADMIN_PORT ?? "4101");
  await processHost.start({ host: "0.0.0.0", port });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void processHost.shutdown({ deadlineMs: 10_000 }).catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Platform Admin shutdown failed", safeError(error));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) throw new Error("PLATFORM_ADMIN_PORT_INVALID");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PLATFORM_ADMIN_PORT_INVALID");
  }
  return port;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "PLATFORM_ADMIN_FAILURE";
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  runPlatformAdminMain().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Platform Admin failed", safeError(error));
  });
}
