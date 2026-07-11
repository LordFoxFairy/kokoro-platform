// HUB-2 上传写面全链路（真 Mongo 27017 + 真 minio 9100）：preview 双档入参 → confirm
// 逐项发布（minio 内容寻址 zip + Mongo upsert + revisions 附集合）→ 恶意包负向逐条。
// 外部依赖 fail-loud：mongo/minio 不可达直接红，不静默 skip。

import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { contentHashOf, packageRef } from "../../src/domain/package.js";
import { MAX_SKILL_PACKAGE_BYTES } from "../../src/domain/validation.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { S3PackageStore } from "../../src/infrastructure/packages/s3-package-store.js";
import { unzipTextFiles, zipTextFiles } from "../../src/infrastructure/zip.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertSkill, type TestHub } from "./helpers.js";

const NS = "ns-upload-http";
const MINIO_ENDPOINT = "http://127.0.0.1:9100";
const MINIO_CREDENTIALS = { accessKeyId: "kokoro", secretAccessKey: "kokoro-secret" };

let hub: TestHub;
let app: FastifyInstance;
let appWithoutStore: FastifyInstance;
let appTightQuota: FastifyInstance;
let s3: S3Client;
let bucket: string;
let store: S3PackageStore;

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

function jsonUpload(zip: Buffer, names?: string[]) {
  return {
    namespace: NS,
    zip_base64: zip.toString("base64"),
    ...(names === undefined ? {} : { names }),
  };
}

function multipartBody(boundary: string, fields: Record<string, string>, zip: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skills.zip"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
  );
  chunks.push(zip);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("upload"));
  s3 = new S3Client({
    endpoint: MINIO_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: MINIO_CREDENTIALS,
  });
  bucket = `kokoro-hub-test-${randomUUID().slice(0, 8)}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket })); // minio 不可达 → 这里直接红。
  store = new S3PackageStore(
    {
      type: "s3",
      endpoint: MINIO_ENDPOINT,
      bucket,
      region: "us-east-1",
      force_path_style: true,
    },
    MINIO_CREDENTIALS,
  );
  const repository = new MongoSkillRepository(hub.collections);
  const quotaLimits = { maxPackages: 100, maxBytes: 10 * 1024 * 1024 * 1024 };
  app = createHubServer({ repository, quotaLimits, packageStore: store });
  appWithoutStore = createHubServer({ repository, quotaLimits, packageStore: null });
  appTightQuota = createHubServer({
    repository,
    quotaLimits: { maxPackages: 1, maxBytes: 1024 * 1024 },
    packageStore: store,
  });
}

const ready = init();

describe("hub upload API (real mongo + real minio)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await appWithoutStore.close();
    await appTightQuota.close();
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    for (const object of listed.Contents ?? []) {
      if (object.Key !== undefined) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      }
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    s3.destroy();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("previews a json base64 upload with ownership conflict flags", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    const files = { "SKILL.md": skillMd("writer"), "guide.md": "extra" };

    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: jsonUpload(zipOf({ writer: files })),
      headers: { "x-kokoro-request-id": "req_preview" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe("req_preview");
    expect(body.data.namespace).toBe(NS);
    expect(body.data.candidates).toHaveLength(1);
    expect(body.data.candidates[0]).toMatchObject({
      name: "writer",
      valid: true,
      errors: [],
      description: "desc of writer",
      content_hash: contentHashOf(files),
      file_count: 2,
      conflicts: { official: true, namespace: false },
    });
  });

  it("previews a multipart upload identically", async () => {
    const files = { "SKILL.md": skillMd("writer") };
    const boundary = `----kokoro${randomUUID().slice(0, 8)}`;

    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: multipartBody(boundary, { namespace: NS }, zipOf({ writer: files })),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.candidates[0]).toMatchObject({
      name: "writer",
      valid: true,
      content_hash: contentHashOf(files),
    });
  });

  it("confirms a publish: content-addressed zip in minio, mongo upsert, revision history", async () => {
    const files = { "SKILL.md": skillMd("writer") };
    const digest = contentHashOf(files);

    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: files })),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.results).toEqual([
      { name: "writer", status: "published", revision: 1, content_hash: digest, error: null },
    ]);

    // 包体：minio 内容寻址 zip 可取回且与源文件一致（agent 双路取包可读）。
    const ref = packageRef(NS, "writer", digest);
    expect(unzipTextFiles(await store.get(ref))).toEqual(files);

    // 元数据：source=upload、revision=1、未软删。
    const doc = await hub.collections.skills.findOne({ scope: NS, name: "writer" });
    expect(doc).toMatchObject({
      source: "upload",
      revision: 1,
      content_hash: digest,
      package_ref: ref,
      deleted_at: null,
      official_enabled: true,
      official_required: false,
    });

    // 版本历史：append-only 一条。
    const revisions = await app.inject({
      method: "GET",
      url: `/hub/skills/${NS}/writer/revisions`,
    });
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json().data.revisions).toHaveLength(1);
    expect(revisions.json().data.revisions[0]).toMatchObject({
      scope: NS,
      name: "writer",
      revision: 1,
      content_hash: digest,
      source: "upload",
    });
  });

  it("republishing identical content is idempotent (unchanged, no new history)", async () => {
    const zip = zipOf({ writer: { "SKILL.md": skillMd("writer") } });
    await app.inject({ method: "POST", url: "/hub/skills/upload/confirm", payload: jsonUpload(zip) });

    const again = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zip),
    });
    expect(again.json().data.results[0]).toMatchObject({ status: "unchanged", revision: 1 });

    const revisions = await app.inject({ method: "GET", url: `/hub/skills/${NS}/writer/revisions` });
    expect(revisions.json().data.revisions).toHaveLength(1);
  });

  it("updating content bumps the CAS revision and keeps old packages for rollback", async () => {
    const v1 = { "SKILL.md": skillMd("writer", "v1") };
    const v2 = { "SKILL.md": skillMd("writer", "v2") };
    await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: v1 })),
    });
    const second = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: v2 })),
    });
    expect(second.json().data.results[0]).toMatchObject({ status: "published", revision: 2 });

    const revisions = await app.inject({ method: "GET", url: `/hub/skills/${NS}/writer/revisions` });
    expect(revisions.json().data.revisions.map((row: { revision: number }) => row.revision)).toEqual([2, 1]);

    // 旧 zip 永存（内容寻址）=回滚零成本。
    expect(unzipTextFiles(await store.get(packageRef(NS, "writer", contentHashOf(v1))))).toEqual(v1);
    expect(unzipTextFiles(await store.get(packageRef(NS, "writer", contentHashOf(v2))))).toEqual(v2);
  });

  it("allows partial success across items", async () => {
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      Bad_Name: { "SKILL.md": skillMd("Bad_Name") },
    });
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zip),
    });
    const results = response.json().data.results as { name: string; status: string; error: string | null }[];
    const byName = new Map(results.map((result) => [result.name, result]));

    expect(byName.get("writer")?.status).toBe("published");
    expect(byName.get("Bad_Name")?.status).toBe("failed");
    expect(byName.get("Bad_Name")?.error).toMatch(/invalid/);
  });

  it("a namespace upload overrides the same-name official skill in the pool", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: { "SKILL.md": skillMd("writer") } })),
    });

    const pool = await app.inject({ method: "GET", url: "/hub/skills/pool", query: { namespace: NS } });
    const cards = pool.json().data.skills as { name: string; scope: string }[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ name: "writer", scope: NS });
  });

  // --- 恶意包负向逐条（真链路上的安全边界）---

  it("rejects a path traversal entry inside a skill directory", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: { "SKILL.md": skillMd("writer"), "../escape.py": "x" } })),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.results[0]).toMatchObject({ status: "failed" });
    expect(response.json().data.results[0].error).toMatch(/unsafe path/);
    expect(await hub.collections.skills.countDocuments({})).toBe(0);
  });

  it("rejects an oversized skill package", async () => {
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer"), "big.txt": "a".repeat(MAX_SKILL_PACKAGE_BYTES) },
    });
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zip),
    });
    expect(response.json().data.results[0].status).toBe("failed");
    expect(response.json().data.results[0].error).toMatch(/too large/);
  });

  it("rejects a reserved skill name", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ skills: { "SKILL.md": skillMd("skills") } })),
    });
    expect(response.json().data.results[0].error).toMatch(/reserved/);
  });

  it("rejects angle bracket injection in the description", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(
        zipOf({ writer: { "SKILL.md": "---\nname: writer\ndescription: 有<注入>风险\n---\nx" } }),
      ),
    });
    expect(response.json().data.results[0].error).toMatch(/angle brackets/);
  });

  it("rejects a zip whose root holds loose files", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: jsonUpload(zipTextFiles({ "SKILL.md": skillMd("writer") })),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("hub.upload_invalid");
  });

  it("rejects a payload that is not a zip archive", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: { namespace: NS, zip_base64: Buffer.from("garbage").toString("base64") },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("hub.upload_invalid");
  });

  it("rejects malformed base64 at the schema boundary", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: { namespace: NS, zip_base64: "!!not-base64!!" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("returns 503 when the package store is unconfigured", async () => {
    const response = await appWithoutStore.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: jsonUpload(zipOf({ writer: { "SKILL.md": skillMd("writer") } })),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("hub.package_store_unconfigured");
  });

  it("enforces the namespace quota on confirm", async () => {
    const zip = zipOf({
      writer: { "SKILL.md": skillMd("writer") },
      helper: { "SKILL.md": skillMd("helper") },
    });
    const response = await appTightQuota.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: { namespace: NS, zip_base64: zip.toString("base64"), names: ["writer", "helper"] },
    });
    const results = response.json().data.results as { status: string; error: string | null }[];
    expect(results[0]?.status).toBe("published");
    expect(results[1]?.status).toBe("failed");
    expect(results[1]?.error).toMatch(/quota exceeded/);
  });
});
