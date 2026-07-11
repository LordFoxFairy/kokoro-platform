import { describe, expect, it } from "vitest";
import { SkillUploadService } from "../../src/application/skill-upload-service.js";
import { OFFICIAL_SCOPE } from "../../src/domain/constants.js";
import { ConcurrentWriteError, PackageStoreError } from "../../src/domain/errors.js";
import { contentHashOf, packageRef } from "../../src/domain/package.js";
import { unzipTextFiles, zipTextFiles } from "../../src/infrastructure/zip.js";
import { FakePackageStore } from "../doubles/fake-package-store.js";
import { FakeSkillRepository } from "../doubles/fake-skill-repository.js";

const NS = "ns-upload";

function skillMd(name: string, description = `desc of ${name}`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`;
}

function zipOf(dirs: Record<string, Record<string, string>>): Buffer {
  const entries: Record<string, string> = {};
  for (const [dir, files] of Object.entries(dirs)) {
    for (const [rel, content] of Object.entries(files)) {
      entries[`${dir}/${rel}`] = content;
    }
  }
  return zipTextFiles(entries);
}

function makeService(overrides?: { maxPackages?: number; maxBytes?: number }) {
  const repo = new FakeSkillRepository();
  const store = new FakePackageStore();
  const service = new SkillUploadService(repo, store, {
    maxPackages: overrides?.maxPackages ?? 10,
    maxBytes: overrides?.maxBytes ?? 1024 * 1024,
  });
  return { repo, store, service };
}

describe("SkillUploadService.preview", () => {
  it("returns valid candidates with manifest, hash and no conflicts", async () => {
    const { service } = makeService();
    const files = { "SKILL.md": skillMd("writer"), "extra.txt": "hi" };
    const preview = await service.preview(NS, zipOf({ writer: files }));

    expect(preview.namespace).toBe(NS);
    expect(preview.candidates).toEqual([
      {
        name: "writer",
        valid: true,
        errors: [],
        description: "desc of writer",
        content_hash: contentHashOf(files),
        package_size: Buffer.byteLength(files["SKILL.md"]) + 2,
        file_count: 2,
        files: [
          { path: "SKILL.md", size: Buffer.byteLength(files["SKILL.md"]) },
          { path: "extra.txt", size: 2 },
        ],
        conflicts: { official: false, namespace: false },
      },
    ]);
  });

  it("marks invalid candidates with per-item errors while keeping valid siblings", async () => {
    const { service } = makeService();
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      Bad_Name: { "SKILL.md": skillMd("Bad_Name") },
    });
    const preview = await service.preview(NS, zip);
    const byName = new Map(preview.candidates.map((candidate) => [candidate.name, candidate]));

    expect(byName.get("writer")?.valid).toBe(true);
    const bad = byName.get("Bad_Name");
    expect(bad?.valid).toBe(false);
    expect(bad?.errors.join()).toMatch(/invalid/);
    expect(bad?.content_hash).toBeNull();
  });

  it("detects ownership conflicts against official and own namespace", async () => {
    const { repo, service } = makeService();
    repo.seedActive(OFFICIAL_SCOPE, "writer", { contentHash: "h1", revision: 3, packageSize: 10 });
    repo.seedActive(NS, "writer", { contentHash: "h2", revision: 1, packageSize: 20 });

    const preview = await service.preview(NS, zipOf({ writer: { "SKILL.md": skillMd("writer") } }));
    expect(preview.candidates[0]?.conflicts).toEqual({ official: true, namespace: true });
  });

  it("rejects a zip with top-level files (skill directories required)", async () => {
    const { service } = makeService();
    await expect(service.preview(NS, zipTextFiles({ "SKILL.md": skillMd("x") }))).rejects.toThrowError(
      /zip root must contain only skill directories/,
    );
  });

  it("rejects an empty zip", async () => {
    const { service } = makeService();
    await expect(service.preview(NS, zipTextFiles({}))).rejects.toThrowError(
      /no skill directories/,
    );
  });
});

describe("SkillUploadService.confirm", () => {
  it("publishes a valid skill: package first, then metadata upsert with source=upload", async () => {
    const { repo, store, service } = makeService();
    const files = { "SKILL.md": skillMd("writer") };
    const results = await service.confirm(NS, zipOf({ writer: files }), null);
    const digest = contentHashOf(files);

    expect(results).toEqual([
      { name: "writer", status: "published", revision: 1, content_hash: digest, error: null },
    ]);
    const ref = packageRef(NS, "writer", digest);
    expect(unzipTextFiles(await store.get(ref))).toEqual(files);
    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]).toMatchObject({
      scope: NS,
      name: "writer",
      source: "upload",
      contentHash: digest,
      packageRef: ref,
    });
    expect(repo.revisionRows).toHaveLength(1);
  });

  it("allows partial success: invalid sibling fails, valid one still publishes", async () => {
    const { service } = makeService();
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      evil: { "SKILL.md": skillMd("evil"), "../escape.py": "x" },
    });
    const results = await service.confirm(NS, zip, null);
    const byName = new Map(results.map((result) => [result.name, result]));

    expect(byName.get("writer")?.status).toBe("published");
    expect(byName.get("evil")?.status).toBe("failed");
    expect(byName.get("evil")?.error).toMatch(/unsafe path/);
  });

  it("short-circuits unchanged content without writing package, metadata or history", async () => {
    const { repo, store, service } = makeService();
    const files = { "SKILL.md": skillMd("writer") };
    repo.seedActive(NS, "writer", {
      contentHash: contentHashOf(files),
      revision: 4,
      packageSize: 10,
    });

    const results = await service.confirm(NS, zipOf({ writer: files }), null);
    expect(results[0]).toMatchObject({ status: "unchanged", revision: 4 });
    expect(store.objects.size).toBe(0);
    expect(repo.upsertCalls).toHaveLength(0);
    expect(repo.revisionRows).toHaveLength(0);
  });

  it("publishes only the selected names and reports unknown names as failed", async () => {
    const { service } = makeService();
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      helper: { "SKILL.md": skillMd("helper") },
    });
    const results = await service.confirm(NS, zip, ["writer", "ghost"]);
    const byName = new Map(results.map((result) => [result.name, result]));

    expect(results).toHaveLength(2);
    expect(byName.get("writer")?.status).toBe("published");
    expect(byName.get("ghost")?.status).toBe("failed");
    expect(byName.get("ghost")?.error).toMatch(/not present/);
  });

  it("enforces the namespace package-count quota per item", async () => {
    const { service } = makeService({ maxPackages: 1 });
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      helper: { "SKILL.md": skillMd("helper") },
    });
    const results = await service.confirm(NS, zip, ["writer", "helper"]);

    expect(results[0]?.status).toBe("published");
    expect(results[1]?.status).toBe("failed");
    expect(results[1]?.error).toMatch(/quota exceeded/);
  });

  it("enforces the namespace byte quota counting replacement delta", async () => {
    const { repo, service } = makeService({ maxBytes: 100 });
    repo.usage = { packageCount: 1, packageBytes: 90 };
    repo.seedActive(NS, "writer", { contentHash: "old-hash", revision: 1, packageSize: 90 });

    // 替换自身：90 字节旧包换 <100 字节新包，delta 语义下不超限。
    const files = { "SKILL.md": skillMd("writer", "short") };
    expect(Buffer.byteLength(files["SKILL.md"])).toBeLessThan(100);
    const results = await service.confirm(NS, zipOf({ writer: files }), null);
    expect(results[0]?.status).toBe("published");
  });

  it("fails the item when the package store write fails, without metadata write", async () => {
    const { repo, store, service } = makeService();
    const files = { "SKILL.md": skillMd("writer") };
    store.failPutRefs.add(packageRef(NS, "writer", contentHashOf(files)));

    const results = await service.confirm(NS, zipOf({ writer: files }), null);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toMatch(/simulated put failure/);
    expect(repo.upsertCalls).toHaveLength(0);
  });

  it("reports a CAS conflict as a failed item (fail-loud, retryable)", async () => {
    const { repo, service } = makeService();
    repo.failNextUpsertWith = new ConcurrentWriteError(NS, "writer");

    const results = await service.confirm(NS, zipOf({ writer: { "SKILL.md": skillMd("writer") } }), null);
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.error).toMatch(/concurrent write conflict/);
  });

  it("fails loud when the package store is unconfigured", async () => {
    const service = new SkillUploadService(new FakeSkillRepository(), null, {
      maxPackages: 10,
      maxBytes: 1024 * 1024,
    });
    await expect(
      service.confirm(NS, zipOf({ writer: { "SKILL.md": skillMd("writer") } }), null),
    ).rejects.toThrowError(PackageStoreError);
  });
});

describe("SkillUploadService.revisions", () => {
  it("returns append-only history newest first", async () => {
    const { service } = makeService();
    await service.confirm(NS, zipOf({ writer: { "SKILL.md": skillMd("writer", "v1") } }), null);
    await service.confirm(NS, zipOf({ writer: { "SKILL.md": skillMd("writer", "v2") } }), null);

    const revisions = await service.revisions(NS, "writer");
    expect(revisions.map((row) => row.revision)).toEqual([2, 1]);
    expect(revisions[0]).toMatchObject({ scope: NS, name: "writer", source: "upload" });
  });
});
