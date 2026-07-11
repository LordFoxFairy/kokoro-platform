// 上传路由请求形状负向（fake 后端即可测：multipart 形状、names 解析、错误归口）。
// 真链路（mongo+minio）见 test/integration/upload-api.test.ts。

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { zipTextFiles } from "../../src/infrastructure/zip.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { FakePackageStore } from "../doubles/fake-package-store.js";
import { FakeSkillRepository } from "../doubles/fake-skill-repository.js";

const NS = "ns-upload-routes";
const SKILL_MD = "---\nname: writer\ndescription: d\n---\nx\n";

const repo = new FakeSkillRepository();
const app: FastifyInstance = createHubServer({
  repository: repo,
  quotaLimits: { maxPackages: 10, maxBytes: 1024 * 1024 },
  packageStore: new FakePackageStore(),
});

function validZip(): Buffer {
  return zipTextFiles({ "writer/SKILL.md": SKILL_MD });
}

function multipart(fields: Record<string, string>, file?: { fieldname: string; data: Buffer }) {
  const boundary = `----kokoro${randomUUID().slice(0, 8)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldname}"; filename="skills.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

describe("upload routes request-shape negatives", () => {
  afterAll(async () => {
    await app.close();
  });

  it("rejects a multipart request without a file part", async () => {
    const { payload, headers } = multipart({ namespace: NS });
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("hub.upload_invalid");
    expect(response.json().error.message).toMatch(/missing zip file part/);
  });

  it("rejects a multipart file part under a wrong field name", async () => {
    const { payload, headers } = multipart({ namespace: NS }, { fieldname: "zip", data: validZip() });
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/exactly one file part named 'file'/);
  });

  it("rejects a multipart names field that is not JSON", async () => {
    const { payload, headers } = multipart(
      { namespace: NS, names: "not-json" },
      { fieldname: "file", data: validZip() },
    );
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/must be a JSON array/);
  });

  it("rejects a multipart names field with a wrong JSON shape", async () => {
    const { payload, headers } = multipart(
      { namespace: NS, names: JSON.stringify({ nope: 1 }) },
      { fieldname: "file", data: validZip() },
    );
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("rejects a multipart request without a namespace field", async () => {
    const { payload, headers } = multipart({}, { fieldname: "file", data: validZip() });
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("accepts a multipart confirm with selected names", async () => {
    const { payload, headers } = multipart(
      { namespace: NS, names: JSON.stringify(["writer"]) },
      { fieldname: "file", data: validZip() },
    );
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.results[0]).toMatchObject({ name: "writer", status: "published" });
  });

  it("rejects a strict-unknown key in the json body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: { namespace: NS, zip_base64: validZip().toString("base64"), extra: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("rejects empty scope params on the revisions route", async () => {
    const response = await app.inject({ method: "GET", url: "/hub/skills/%20/writer/revisions" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("request.invalid");
  });

  it("maps unexpected preview failures to a 500 envelope", async () => {
    const failingRepo = new FakeSkillRepository();
    failingRepo.findActive = async () => {
      throw new Error("boom");
    };
    const failingApp = createHubServer({
      repository: failingRepo,
      quotaLimits: { maxPackages: 10, maxBytes: 1024 * 1024 },
      packageStore: new FakePackageStore(),
    });
    const response = await failingApp.inject({
      method: "POST",
      url: "/hub/skills/upload/preview",
      payload: { namespace: NS, zip_base64: validZip().toString("base64") },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("hub.upload_preview_failed");
    await failingApp.close();
  });

  it("maps unexpected confirm failures to a 500 envelope", async () => {
    const failingRepo = new FakeSkillRepository();
    failingRepo.quotaUsage = async () => {
      throw new Error("boom");
    };
    const failingApp = createHubServer({
      repository: failingRepo,
      quotaLimits: { maxPackages: 10, maxBytes: 1024 * 1024 },
      packageStore: new FakePackageStore(),
    });
    const response = await failingApp.inject({
      method: "POST",
      url: "/hub/skills/upload/confirm",
      payload: { namespace: NS, zip_base64: validZip().toString("base64") },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("hub.upload_confirm_failed");
    await failingApp.close();
  });
});
