import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const definitions = Object.freeze([
  Object.freeze({
    name: "product-surface-catalog",
    sourcePath: "contract/spec/product-surface-catalog.yaml",
    schemaId: "https://contracts.kokoro.dev/product-surface-catalog/v1",
  }),
  Object.freeze({
    name: "launch-product-profile",
    sourcePath: "contract/spec/launch-product-profile.yaml",
    schemaId: "https://contracts.kokoro.dev/launch-product-profile/v1",
  }),
]);

const check = process.argv.includes("--check");
const explicitRootIndex = process.argv.indexOf("--root");
const root = explicitRootIndex >= 0
  ? path.resolve(requiredArgument(explicitRootIndex + 1))
  : path.resolve(process.cwd(), "..");
const output = path.resolve(process.cwd(), "src/interfaces/json-schema/generated-product-catalog");
const manifestPath = path.join(output, "contract-metadata.json");
const recordedManifest = check ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
const revisionIndex = process.argv.indexOf("--root-revision");
const requestedRevision = revisionIndex >= 0
  ? requiredArgument(revisionIndex + 1)
  : recordedManifest?.sourceCommit;
if (typeof requestedRevision !== "string" || !/^[a-f0-9]{7,64}$/u.test(requestedRevision)) {
  fail("explicit_root_revision_required");
}
const resolvedCommit = resolveCommit(root, requestedRevision);
const rootAvailable = resolvedCommit !== null;
const sourceCommit = resolvedCommit ?? requestedRevision;
if (!check && !rootAvailable) fail("committed_root_source_unavailable");

const metadata = [];
for (const definition of definitions) {
  const target = path.join(output, `${definition.name}.schema.json`);
  const source = rootAvailable
    ? committedBlob(root, sourceCommit, definition.sourcePath)
    : await readFile(target);
  const document = parseSchema(source, definition);
  const generated = `${stableJson(document, 0)}\n`;
  const generatedBytes = Buffer.from(generated, "utf8");
  if (check) {
    const current = await readFile(target);
    if (!current.equals(generatedBytes)) fail(`${definition.name}:generated_artifact_drift`);
  } else {
    await writeFile(target, generatedBytes);
  }
  metadata.push(Object.freeze({
    schemaId: definition.schemaId,
    sourceCommit,
    sourcePath: definition.sourcePath,
    sourceDigestSha256: sha256(source),
    artifactDigestSha256: sha256(generatedBytes),
  }));
}

const manifest = `${stableJson({
  generator: "kokoro-platform/scripts/contract/generate-product-publication-schemas.mjs",
  generatorVersion: 2,
  artifactKind: "root-json-schema-2020-12-mirror",
  sourceCommit,
  schemas: metadata,
}, 0)}\n`;
if (check) {
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const item of metadata) {
    const recorded = current.schemas?.find((candidate) => candidate.schemaId === item.schemaId);
    if (recorded?.artifactDigestSha256 !== item.artifactDigestSha256 ||
        recorded?.sourcePath !== item.sourcePath ||
        recorded?.sourceCommit !== item.sourceCommit ||
        (rootAvailable && recorded?.sourceDigestSha256 !== item.sourceDigestSha256)) {
      fail(`${item.schemaId}:metadata_drift`);
    }
  }
} else {
  await writeFile(manifestPath, manifest, "utf8");
}

function parseSchema(bytes, definition) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { fail(`${definition.name}:source_not_json`); }
  if (value?.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
      value?.$id !== definition.schemaId) fail(`${definition.name}:schema_identity_mismatch`);
  return value;
}

function stableJson(value, depth) {
  if (depth > 128) fail("schema_nesting_exceeded");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function resolveCommit(repository, revision) {
  try {
    return execFileSync("git", ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}
function committedBlob(repository, revision, sourcePath) {
  try {
    return execFileSync("git", ["-C", repository, "show", `${revision}:${sourcePath}`],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { fail(`${sourcePath}:committed_blob_unavailable`); }
}
function requiredArgument(index) { const value = process.argv[index]; if (!value) fail("argument_required"); return value; }
function fail(message) { throw new Error(`product_publication_schema_generation:${message}`); }
