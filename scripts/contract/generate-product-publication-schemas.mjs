import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const schemaDefinitions = Object.freeze([
  Object.freeze({
    name: "product-surface-catalog",
    rootPath: "contract/spec/product-surface-catalog.yaml",
    schemaId: "https://contracts.kokoro.dev/product-surface-catalog/v1",
  }),
  Object.freeze({
    name: "launch-product-profile",
    rootPath: "contract/spec/launch-product-profile.yaml",
    schemaId: "https://contracts.kokoro.dev/launch-product-profile/v1",
  }),
]);
const protoPaths = Object.freeze([
  "kokoro/common/v1/error.proto",
  "kokoro/common/v2/command_envelope.proto",
  "kokoro/platform/admin/v2/admin_shared.proto",
  "kokoro/platform/publication/v1/publication_common.proto",
  "kokoro/platform/product/v1/product_catalog_publication.proto",
]);
const allSources = Object.freeze([
  ...schemaDefinitions.map((definition) => Object.freeze({
    kind: "json-schema",
    rootPath: definition.rootPath,
  })),
  ...protoPaths.map((protoPath) => Object.freeze({
    kind: "protobuf",
    rootPath: `contract/proto/${protoPath}`,
  })),
]);

const repository = process.cwd();
const vendorRoot = path.resolve(repository, "contract/vendor/product-catalog-publication");
const provenancePath = path.join(vendorRoot, "provenance.json");
const jsonOutput = path.resolve(repository, "src/interfaces/json-schema/generated-product-catalog");
const protoOutput = path.resolve(repository, "src/interfaces/connect/generated-product-catalog-publication");
const check = process.argv.includes("--check");
const updateVendor = process.argv.includes("--update-vendor");
const rootIndex = process.argv.indexOf("--root");
const revisionIndex = process.argv.indexOf("--root-revision");
const explicitRoot = rootIndex < 0 ? null : path.resolve(requiredArgument(rootIndex + 1));
const requestedRevision = revisionIndex < 0 ? null : requiredArgument(revisionIndex + 1);
if (updateVendor && (explicitRoot === null || requestedRevision === null)) {
  fail("vendor_update_requires_explicit_root_revision");
}
if (requestedRevision !== null && explicitRoot === null) fail("root_revision_without_root");

const recorded = updateVendor ? null : parseJson(await readFile(provenancePath), "provenance_invalid");
const sourceCommit = explicitRoot === null
  ? requiredCommit(recorded?.sourceCommit)
  : resolveCommit(explicitRoot, requestedRevision ?? requiredCommit(recorded?.sourceCommit));
if (!updateVendor && recorded?.sourceCommit !== sourceCommit) fail("source_commit_mismatch");

if (updateVendor) {
  for (const source of allSources) {
    const target = vendorPath(source.rootPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, committedBlob(explicitRoot, sourceCommit, source.rootPath));
  }
}

const sourceEvidence = [];
for (const source of allSources) {
  const bytes = await readFile(vendorPath(source.rootPath));
  const digest = sha256(bytes);
  if (!updateVendor) {
    const expected = recorded.sources?.find((item) => item.rootPath === source.rootPath);
    if (expected?.kind !== source.kind || expected?.sourceDigestSha256 !== digest) {
      fail(`${source.rootPath}:vendored_source_digest_mismatch`);
    }
  }
  if (explicitRoot !== null) {
    const rootBytes = committedBlob(explicitRoot, sourceCommit, source.rootPath);
    if (!sameBytes(bytes, rootBytes)) fail(`${source.rootPath}:root_vendor_byte_mismatch`);
  }
  sourceEvidence.push(Object.freeze({
    kind: source.kind,
    rootPath: source.rootPath,
    vendorPath: path.relative(repository, vendorPath(source.rootPath)).replaceAll("\\", "/"),
    sourceDigestSha256: digest,
  }));
}

const schemaEvidence = [];
for (const definition of schemaDefinitions) {
  const source = await readFile(vendorPath(definition.rootPath));
  const document = parseSchema(source, definition);
  const generated = Buffer.from(`${stableJson(document, 0)}\n`, "utf8");
  const target = path.join(jsonOutput, `${definition.name}.schema.json`);
  if (check) {
    if (!sameBytes(await readFile(target), generated)) fail(`${definition.name}:generated_artifact_drift`);
  } else {
    await writeFile(target, generated);
  }
  schemaEvidence.push(Object.freeze({
    schemaId: definition.schemaId,
    rootPath: definition.rootPath,
    sourceDigestSha256: sha256(source),
    artifactPath: path.relative(repository, target).replaceAll("\\", "/"),
    artifactDigestSha256: sha256(generated),
  }));
}

const generatedProtoMetadata = await readGeneratedProtoMetadata();
const protoSourceDigest = await aggregateProtoSources();
if (generatedProtoMetadata.sourceDigestSha256 !== protoSourceDigest ||
    stableJson(generatedProtoMetadata.sourcePaths, 0) !== stableJson(protoPaths, 0)) {
  fail("protobuf_generated_source_binding_mismatch");
}
const protoArtifactDigest = await artifactDigest(protoOutput);
if (generatedProtoMetadata.artifactDigestSha256 !== protoArtifactDigest) {
  fail("protobuf_generated_artifact_binding_mismatch");
}

const provenance = Object.freeze({
  artifactKind: "root-product-catalog-publication-vendor-v1",
  generator: "scripts/contract/generate-product-publication-schemas.mjs",
  generatorVersion: 3,
  sourceCommit,
  sources: sourceEvidence,
  jsonSchemas: schemaEvidence,
  protobuf: Object.freeze({
    schemaId: generatedProtoMetadata.schemaId,
    schemaVersion: generatedProtoMetadata.schemaVersion,
    sourcePaths: protoPaths,
    aggregateSourceDigestSha256: protoSourceDigest,
    generatedArtifactPath: path.relative(repository, protoOutput).replaceAll("\\", "/"),
    generatedArtifactDigestSha256: protoArtifactDigest,
    generatorVersion: generatedProtoMetadata.generatorVersion,
    runtimeVersion: generatedProtoMetadata.runtimeVersion,
  }),
});
const provenanceBytes = Buffer.from(`${stableJson(provenance, 0)}\n`, "utf8");
if (updateVendor) {
  await writeFile(provenancePath, provenanceBytes);
} else if (!sameBytes(await readFile(provenancePath), provenanceBytes)) {
  fail("provenance_drift");
}

const runtimeMetadata = Object.freeze({
  artifactKind: "root-json-schema-2020-12-mirror",
  generator: provenance.generator,
  generatorVersion: provenance.generatorVersion,
  sourceCommit,
  schemas: schemaEvidence.map((schema) => Object.freeze({
    schemaId: schema.schemaId,
    sourceCommit,
    sourcePath: schema.rootPath,
    sourceDigestSha256: schema.sourceDigestSha256,
    artifactDigestSha256: schema.artifactDigestSha256,
  })),
});
const runtimeMetadataBytes = Buffer.from(`${stableJson(runtimeMetadata, 0)}\n`, "utf8");
const runtimeMetadataPath = path.join(jsonOutput, "contract-metadata.json");
if (check) {
  if (!sameBytes(await readFile(runtimeMetadataPath), runtimeMetadataBytes)) {
    fail("runtime_schema_metadata_drift");
  }
} else {
  await writeFile(runtimeMetadataPath, runtimeMetadataBytes);
}

function vendorPath(rootPath) {
  return path.join(vendorRoot, rootPath);
}

async function aggregateProtoSources() {
  const hash = createHash("sha256");
  for (const protoPath of protoPaths) {
    hash.update(`${protoPath}\0`);
    hash.update(await readFile(vendorPath(`contract/proto/${protoPath}`)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readGeneratedProtoMetadata() {
  const source = await readFile(path.join(protoOutput, "contract-metadata.ts"), "utf8");
  const strings = (field) => {
    const match = source.match(new RegExp(`${field}: "([a-f0-9]+)"`, "u"));
    if (match?.[1] === undefined) fail(`protobuf_metadata_${field}_missing`);
    return match[1];
  };
  const text = (field) => {
    const match = source.match(new RegExp(`${field}: "([^"]+)"`, "u"));
    if (match?.[1] === undefined) fail(`protobuf_metadata_${field}_missing`);
    return match[1];
  };
  const number = (field) => {
    const match = source.match(new RegExp(`${field}: ([0-9]+)`, "u"));
    if (match?.[1] === undefined) fail(`protobuf_metadata_${field}_missing`);
    return Number(match[1]);
  };
  const paths = [...source.matchAll(/^\s+"([^"]+\.proto)",$/gmu)].map((match) => match[1]);
  return Object.freeze({
    schemaId: text("schemaId"),
    schemaVersion: number("schemaVersion"),
    sourceDigestSha256: strings("sourceDigestSha256"),
    artifactDigestSha256: strings("artifactDigestSha256"),
    sourcePaths: paths,
    generatorVersion: text("generatorVersion"),
    runtimeVersion: text("runtimeVersion"),
  });
}

async function artifactFiles(directory, current = directory) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await artifactFiles(directory, target));
    else if (entry.isFile() && entry.name !== "contract-metadata.ts") files.push(target);
  }
  return files;
}

async function artifactDigest(directory) {
  const hash = createHash("sha256");
  for (const target of await artifactFiles(directory)) {
    const relative = path.relative(directory, target).replaceAll("\\", "/");
    hash.update(`${relative}\0`);
    hash.update(await readFile(target));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseSchema(bytes, definition) {
  const value = parseJson(bytes, `${definition.name}:source_not_json`);
  if (value?.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
      value?.$id !== definition.schemaId) fail(`${definition.name}:schema_identity_mismatch`);
  return value;
}

function parseJson(bytes, code) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail(code); }
}

function stableJson(value, depth) {
  if (depth > 128) fail("schema_nesting_exceeded");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`).join(",")}}`;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sameBytes(left, right) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function requiredCommit(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) fail("source_commit_invalid");
  return value;
}
function resolveCommit(root, revision) {
  if (revision === null || !/^[a-f0-9]{7,64}$/u.test(revision)) fail("root_revision_invalid");
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "--verify", `${revision}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { fail("committed_root_source_unavailable"); }
}
function committedBlob(root, revision, rootPath) {
  try {
    return execFileSync("git", ["-C", root, "show", `${revision}:${rootPath}`],
      { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch { fail(`${rootPath}:committed_blob_unavailable`); }
}
function requiredArgument(index) {
  const value = process.argv[index];
  if (!value || value.startsWith("--")) fail("argument_required");
  return value;
}
function fail(message) { throw new Error(`product_publication_contract_generation:${message}`); }
