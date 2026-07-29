import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { loadPlatformDatabaseConfig } from "../../src/infrastructure/postgres/client.js";
import { digestAdminValue } from
  "../../src/modules/admin-control/application/admin-digest.js";

interface BootstrapDocument {
  readonly version: 1;
  readonly authorities: readonly Readonly<Record<string, unknown>>[];
}

export async function loadBootstrapDocument(path: string): Promise<Readonly<{
  authorities: BootstrapDocument["authorities"];
  configurationDigest: string;
}>> {
  if (!isAbsolute(path)) throw new Error("ADMIN_BOOTSTRAP_FILE_MUST_BE_ABSOLUTE");
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size < 2 || metadata.size > 256 * 1024 || (metadata.mode & 0o077) !== 0) {
    throw new Error("ADMIN_BOOTSTRAP_FILE_UNSAFE");
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
      throw new Error("ADMIN_BOOTSTRAP_FILE_CHANGED");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  }
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "authorities,version" || root.version !== 1 ||
    !Array.isArray(root.authorities) || root.authorities.length < 2 || root.authorities.length > 16 ||
    root.authorities.some((value) => value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  }
  const authorities = Object.freeze(root.authorities.map((value) =>
    Object.freeze({ ...(value as Record<string, unknown>) })));
  return Object.freeze({
    authorities,
    configurationDigest: digestAdminValue(authorities as never),
  });
}

export async function runAdminAuthorityBootstrap(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const document = await loadBootstrapDocument(path);
  const config = loadPlatformDatabaseConfig("migrator", environment);
  const client = new Client({
    connectionString: config.url,
    application_name: "kokoro-platform-admin-authority-bootstrap",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  await client.connect();
  try {
    const result = await client.query<{ insertedCount: number }>(
      `SELECT platform.bootstrap_admin_authorities($1::jsonb,$2::char(64)) AS "insertedCount"`,
      [JSON.stringify(document.authorities), document.configurationDigest],
    );
    const count = result.rows[0]?.insertedCount;
    if (!Number.isInteger(count) || count !== document.authorities.length) {
      throw new Error("ADMIN_BOOTSTRAP_RESULT_INVALID");
    }
    return count;
  } finally {
    await client.end();
  }
}

function bootstrapPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--file" || args[1] === undefined) {
    throw new Error("USAGE: admin:bootstrap-authority --file /absolute/path/bootstrap.json");
  }
  return args[1];
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  runAdminAuthorityBootstrap(bootstrapPath(process.argv.slice(2)))
    .then((count) => console.info(`Bootstrapped and sealed ${count} Admin authorities.`))
    .catch((error: unknown) => {
      process.exitCode = 1;
      console.error("Admin authority bootstrap failed", error instanceof Error ? error.message : error);
    });
}
