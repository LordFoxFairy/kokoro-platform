import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { loadPlatformDatabaseConfig } from "../infrastructure/postgres/client.js";
import { digestAdminValue } from
  "../modules/admin-control/application/admin-digest.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const epoch = z.string().regex(/^[1-9][0-9]*$/u).refine((value) =>
  BigInt(value) <= 9_223_372_036_854_775_807n);
const permission = z.string().max(128).regex(/^[a-z][a-z0-9.-]*(?:\.\*)?$/u);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .refine((value) => Date.parse(value) > Date.now());
const boundedText = z.string().min(1).max(256).refine((value) => value === value.normalize("NFC") &&
  ![...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127 || (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069);
  }));
const environmentOrRegion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/u);
const siteScope = z.object({
  siteRef: identifier.refine((value) => value !== "*"),
  environment: environmentOrRegion,
  region: environmentOrRegion,
  scopeEpoch: epoch,
  expiresAt: instant,
}).strict();
const globalScope = z.object({
  grantRef: uuid,
  environment: environmentOrRegion,
  region: environmentOrRegion,
  scopeEpoch: epoch,
  expiresAt: instant,
}).strict();
const identity = z.object({
  identityRef: uuid,
  issuer: z.string().min(8).max(512).refine(validIssuer),
  subject: boundedText,
}).strict();
const authority = z.object({
  operatorRef: identifier,
  operatorGeneration: epoch,
  permissions: z.array(permission).min(2).max(256).refine(unique)
    .refine((values) => values.includes("admin.approval.execute") &&
      values.includes("admin.authority.manage")),
  operatorSecurityEpoch: epoch,
  authorizationEpoch: epoch,
  expiresAt: instant,
  siteScopes: z.array(siteScope).max(256).refine((values) => uniqueBy(values, (value) =>
    `${value.siteRef}\0${value.environment}\0${value.region}`)),
  globalScopes: z.array(globalScope).min(1).max(256).refine((values) => uniqueBy(values,
    (value) => value.grantRef)),
  identities: z.array(identity).min(1).max(256).refine((values) =>
    uniqueBy(values, (value) => value.identityRef) && uniqueBy(values, (value) =>
      `${value.issuer}\0${value.subject}`)),
}).strict();
const bootstrapDocument = z.object({
  version: z.literal(1),
  authorities: z.array(authority).min(2).max(16),
}).strict().superRefine((value, context) => {
  const uniqueAuthorities = uniqueBy(value.authorities, (item) => item.operatorRef);
  const scopes = value.authorities.flatMap((item) => item.globalScopes);
  const identities = value.authorities.flatMap((item) => item.identities);
  if (!uniqueAuthorities || !uniqueBy(scopes, (item) => item.grantRef) ||
      !uniqueBy(identities, (item) => item.identityRef) ||
      !uniqueBy(identities, (item) => `${item.issuer}\0${item.subject}`)) {
    context.addIssue({ code: "custom", message: "duplicate bootstrap authority fact" });
  }
});

type BootstrapDocument = z.infer<typeof bootstrapDocument>;

export async function loadBootstrapDocument(path: string): Promise<Readonly<{
  authorities: Readonly<BootstrapDocument["authorities"]>;
  configurationDigest: string;
}>> {
  if (!isAbsolute(path)) throw new Error("ADMIN_BOOTSTRAP_FILE_MUST_BE_ABSOLUTE");
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 ||
      metadata.size > 256 * 1024 || (metadata.mode & 0o077) !== 0) {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  }
  const result = bootstrapDocument.safeParse(parsed);
  if (!result.success) {
    throw new Error("ADMIN_BOOTSTRAP_DOCUMENT_INVALID");
  }
  const authorities = deepFreeze(result.data.authorities);
  return Object.freeze({
    authorities,
    configurationDigest: digestAdminValue(authorities as never),
  });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string): boolean {
  return new Set(values.map(key)).size === values.length;
}

function validIssuer(value: string): boolean {
  if (value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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

export function adminAuthorityBootstrapPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--file" || args[1] === undefined) {
    throw new Error("USAGE: admin-authority-bootstrap --file /absolute/path/bootstrap.json");
  }
  return args[1];
}

async function main(): Promise<void> {
  const count = await runAdminAuthorityBootstrap(
    adminAuthorityBootstrapPath(process.argv.slice(2)),
  );
  console.info(`Bootstrapped and sealed ${count} Admin authorities.`);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    console.error("Admin authority bootstrap failed", error instanceof Error ? error.message : error);
  });
}
