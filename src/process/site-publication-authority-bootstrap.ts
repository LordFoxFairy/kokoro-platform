import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { canonicalDigest } from
  "../modules/product-catalog/domain/canonical-product-document.js";
import {
  parseSitePublicationAuthorityBootstrapDocument,
  type SitePublicationAuthorityBootstrapDocument,
} from
  "../modules/site/infrastructure/postgres/site-publication-authority-bootstrap-document.js";
import { loadPlatformDatabaseConfig } from "../infrastructure/postgres/client.js";

export async function loadSitePublicationAuthorityBootstrapDocument(path: string): Promise<Readonly<{
  document: SitePublicationAuthorityBootstrapDocument;
  configurationDigest: string;
}>> {
  if (!isAbsolute(path)) throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FILE_MUST_BE_ABSOLUTE");
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
      metadata.size > 4 * 1024 * 1024 || (metadata.mode & 0o077) !== 0) {
    throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FILE_UNSAFE");
  }
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const opened = await handle.stat();
    if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) {
      throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FILE_CHANGED");
    }
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  try {
    const document = parseSitePublicationAuthorityBootstrapDocument(JSON.parse(raw) as unknown);
    return Object.freeze({ document, configurationDigest: canonicalDigest(document).slice(7) });
  } catch (error) {
    if (error instanceof Error && error.message === "SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FILE_CHANGED") {
      throw error;
    }
    throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_DOCUMENT_INVALID");
  }
}

export async function runSitePublicationAuthorityBootstrap(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const authority = await loadSitePublicationAuthorityBootstrapDocument(path);
  const config = loadPlatformDatabaseConfig("migrator", environment);
  const client = new Client({
    connectionString: config.url,
    application_name: "kokoro-platform-site-publication-authority-bootstrap",
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  await client.connect();
  try {
    const result = await client.query<{ insertedCount: number }>(
      `SELECT platform.bootstrap_site_publication_authorities($1::jsonb,$2::char(64))
         AS "insertedCount"`,
      [JSON.stringify(authority.document), authority.configurationDigest],
    );
    const insertedCount = result.rows[0]?.insertedCount;
    const expected = authority.document.effectiveAccess.length +
      authority.document.intentIssuers.length + authority.document.producerTrust.length;
    if (!Number.isInteger(insertedCount) || insertedCount !== expected) {
      throw new Error("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_RESULT_INVALID");
    }
    return insertedCount;
  } finally {
    await client.end();
  }
}

export function sitePublicationAuthorityBootstrapPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--file" || args[1] === undefined) {
    throw new Error("USAGE: site-publication-authority-bootstrap --file /absolute/path/authority.json");
  }
  return args[1];
}

async function main(): Promise<void> {
  const count = await runSitePublicationAuthorityBootstrap(
    sitePublicationAuthorityBootstrapPath(process.argv.slice(2)),
  );
  console.info(`Bootstrapped and sealed ${count} Site publication authority records.`);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Site publication authority bootstrap failed",
      error instanceof Error ? error.message : "SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FAILED");
  });
}
