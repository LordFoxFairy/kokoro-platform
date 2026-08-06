#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

const repository = await realpath(resolve(process.argv[2] ?? process.cwd()));
const provenancePath = "src/generated/provenance.json";
const generatedRoots = Object.freeze([
  "src/generated/contracts",
  "src/generated/proto",
  "src/generated/schema",
]);

const provenance = JSON.parse(await readFile(repositoryPath(provenancePath), "utf8"));
assertRecord(provenance, "GENERATED_PROVENANCE_SHAPE_INVALID");
assertEqual(provenance.contractRevision, "kokoro.generated-artifact-provenance.v1",
  "GENERATED_PROVENANCE_REVISION_INVALID");
assertEqual(provenance.boundaryId, "generated-kokoro-platform@v1",
  "GENERATED_PROVENANCE_BOUNDARY_INVALID");
assertEqual(provenance.consumerRepository, "kokoro-platform",
  "GENERATED_PROVENANCE_CONSUMER_INVALID");
assertPattern(provenance.sourceRootCommit, /^[a-f0-9]{40}$/u,
  "GENERATED_PROVENANCE_SOURCE_COMMIT_INVALID");
validateRows(provenance.sourceFiles, "source");
validateGenerator(provenance.generator);
const outputs = validateRows(provenance.outputs, "output");

const declared = new Set();
for (const output of outputs) {
  if (!generatedRoots.some((root) => output.path.startsWith(`${root}/`))) {
    fail("GENERATED_PROVENANCE_OUTPUT_PATH_INVALID", output.path);
  }
  const file = repositoryPath(output.path);
  const stat = await lstat(file).catch(() => fail("GENERATED_CONTRACT_OUTPUT_MISSING", output.path));
  if (!stat.isFile() || stat.isSymbolicLink()) fail("GENERATED_CONTRACT_OUTPUT_INVALID", output.path);
  const digest = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  assertEqual(digest, output.sha256, "GENERATED_CONTRACT_OUTPUT_DRIFT", output.path);
  declared.add(output.path);
}

const actual = new Set((await Promise.all(generatedRoots.map(walk))).flat());
assertEqual(JSON.stringify(byteSorted([...actual])), JSON.stringify(byteSorted([...declared])),
  "GENERATED_CONTRACT_OUTPUT_SET_DRIFT");
const manifestDigest = `sha256:${createHash("sha256")
  .update(canonicalJson(Object.fromEntries(Object.entries(provenance)
    .filter(([key]) => key !== "manifestDigest"))))
  .digest("hex")}`;
assertEqual(provenance.manifestDigest, manifestDigest, "GENERATED_PROVENANCE_DIGEST_INVALID");

process.stdout.write(`generated_contracts_verified:${outputs.length}\n`);

async function walk(relative) {
  const directory = repositoryPath(relative);
  const stat = await lstat(directory).catch(() => fail("GENERATED_CONTRACT_ROOT_MISSING", relative));
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("GENERATED_CONTRACT_ROOT_INVALID", relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...await walk(child));
    else if (entry.isFile()) paths.push(child);
    else fail("GENERATED_CONTRACT_OUTPUT_INVALID", child);
  }
  return paths;
}

function validateRows(value, kind) {
  if (!Array.isArray(value) || value.length === 0) fail("GENERATED_PROVENANCE_SHAPE_INVALID", kind);
  const rows = value.map((entry) => {
    assertRecord(entry, "GENERATED_PROVENANCE_SHAPE_INVALID");
    assertPattern(entry.path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\x21-\x7e]+$/u,
      "GENERATED_PROVENANCE_PATH_INVALID");
    assertPattern(entry.sha256, /^sha256:[a-f0-9]{64}$/u,
      "GENERATED_PROVENANCE_DIGEST_INVALID");
    return entry;
  });
  const paths = rows.map(({ path }) => path);
  assertEqual(JSON.stringify(paths), JSON.stringify(byteSorted(paths)),
    "GENERATED_PROVENANCE_PATH_ORDER_INVALID");
  assertEqual(new Set(paths).size, paths.length, "GENERATED_PROVENANCE_PATH_DUPLICATE");
  return rows;
}

function validateGenerator(value) {
  assertRecord(value, "GENERATED_PROVENANCE_GENERATOR_INVALID");
  assertEqual(value.name, "contract/generate.mjs", "GENERATED_PROVENANCE_GENERATOR_INVALID");
  assertEqual(value.version, "kokoro.consumer-generation.v1",
    "GENERATED_PROVENANCE_GENERATOR_INVALID");
  assertPattern(value.lockDigest, /^sha256:[a-f0-9]{64}$/u,
    "GENERATED_PROVENANCE_GENERATOR_INVALID");
  assertEqual(JSON.stringify(value.argv), JSON.stringify([
    "--consumer", "kokoro-platform", "--source-root", "@source-root",
    "--output-repository", "@consumer-root",
  ]), "GENERATED_PROVENANCE_GENERATOR_INVALID");
}

function repositoryPath(relative) {
  const target = resolve(repository, ...relative.split("/"));
  if (!target.startsWith(`${repository}${sep}`)) fail("GENERATED_PROVENANCE_PATH_INVALID", relative);
  return target;
}

function canonicalJson(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("GENERATED_PROVENANCE_SHAPE_INVALID");
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assertRecord(value, "GENERATED_PROVENANCE_SHAPE_INVALID");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function byteSorted(values) {
  return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function assertRecord(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
}

function assertPattern(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) fail(code, String(value));
}

function assertEqual(actual, expected, code, detail = "") {
  if (actual !== expected) fail(code, detail);
}

function fail(code, detail = "") {
  throw new Error(detail.length === 0 ? code : `${code}:${detail}`);
}
