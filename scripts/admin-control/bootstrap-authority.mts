import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  adminAuthorityBootstrapPath,
  loadBootstrapDocument,
  runAdminAuthorityBootstrap,
} from "../../src/process/admin-authority-bootstrap.js";

export { loadBootstrapDocument, runAdminAuthorityBootstrap };

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  runAdminAuthorityBootstrap(adminAuthorityBootstrapPath(process.argv.slice(2)))
    .then((count) => console.info(`Bootstrapped and sealed ${count} Admin authorities.`))
    .catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Admin authority bootstrap failed", error instanceof Error ? error.message : error);
    });
}
