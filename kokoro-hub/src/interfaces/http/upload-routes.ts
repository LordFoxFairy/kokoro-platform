// skills 上传写面路由（HUB-2）：preview（纯校验+归属冲突）/ confirm（逐项发布，部分成功）/
// revisions（append-only 版本历史）。入参双档：multipart（file part=zip）或 JSON base64。

import { readRequestContext, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { SkillUploadService } from "../../application/skill-upload-service.js";
import { PackageStoreError, SkillValidationError } from "../../domain/errors.js";
import { MAX_UPLOAD_ZIP_BYTES } from "../../domain/validation.js";
import {
  scopeNameParamsSchema,
  selfUploadJsonBodySchema,
  selfUploadMultipartFieldsSchema,
  uploadJsonBodySchema,
  uploadMultipartFieldsSchema,
} from "./schemas.js";

// JSON 档 body 上限：base64 膨胀 4/3，给 zip 硬顶留足余量。
export const UPLOAD_BODY_LIMIT = 96 * 1024 * 1024;

interface UploadPayload {
  namespace: string;
  zip: Buffer;
  names: string[] | null;
}

// self 面上传载荷：namespace 由信封头注入，不在 body 内。
export interface UploadZipPayload {
  zip: Buffer;
  names: string[] | null;
}

export class UploadRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadRequestError";
  }
}

async function readMultipartUpload(request: FastifyRequest): Promise<UploadPayload> {
  let zip: Buffer | null = null;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || zip !== null) {
        throw new UploadRequestError(400, "hub.upload_invalid", "expect exactly one file part named 'file'");
      }
      try {
        zip = await part.toBuffer();
      } catch {
        throw new UploadRequestError(
          413,
          "hub.upload_too_large",
          `zip exceeds ${MAX_UPLOAD_ZIP_BYTES} bytes`,
        );
      }
    } else if (typeof part.value === "string") {
      fields[part.fieldname] = part.value;
    }
  }
  if (zip === null) {
    throw new UploadRequestError(400, "hub.upload_invalid", "missing zip file part 'file'");
  }
  let names: unknown;
  if (fields.names !== undefined) {
    try {
      names = JSON.parse(fields.names);
    } catch {
      throw new UploadRequestError(400, "hub.upload_invalid", "field 'names' must be a JSON array");
    }
  }
  const parsed = uploadMultipartFieldsSchema.parse({
    namespace: fields.namespace,
    ...(names === undefined ? {} : { names }),
  });
  return { namespace: parsed.namespace, zip, names: parsed.names ?? null };
}

function readJsonUpload(body: unknown): UploadPayload {
  const parsed = uploadJsonBodySchema.parse(body);
  const zip = Buffer.from(parsed.zip_base64, "base64");
  if (zip.byteLength > MAX_UPLOAD_ZIP_BYTES) {
    throw new UploadRequestError(
      413,
      "hub.upload_too_large",
      `zip exceeds ${MAX_UPLOAD_ZIP_BYTES} bytes`,
    );
  }
  return { namespace: parsed.namespace, zip, names: parsed.names ?? null };
}

async function readUploadPayload(request: FastifyRequest): Promise<UploadPayload> {
  if (request.isMultipart()) {
    return readMultipartUpload(request);
  }
  return readJsonUpload(request.body);
}

// self 面上传：只取 zip+names，namespace 恒来自信封头；body/multipart 携带 namespace/scope 视为伪造(400)。
async function readSelfMultipartUpload(request: FastifyRequest): Promise<UploadZipPayload> {
  let zip: Buffer | null = null;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || zip !== null) {
        throw new UploadRequestError(400, "hub.upload_invalid", "expect exactly one file part named 'file'");
      }
      try {
        zip = await part.toBuffer();
      } catch {
        throw new UploadRequestError(
          413,
          "hub.upload_too_large",
          `zip exceeds ${MAX_UPLOAD_ZIP_BYTES} bytes`,
        );
      }
    } else if (typeof part.value === "string") {
      fields[part.fieldname] = part.value;
    }
  }
  if (zip === null) {
    throw new UploadRequestError(400, "hub.upload_invalid", "missing zip file part 'file'");
  }
  let names: unknown;
  if (fields.names !== undefined) {
    try {
      names = JSON.parse(fields.names);
    } catch {
      throw new UploadRequestError(400, "hub.upload_invalid", "field 'names' must be a JSON array");
    }
  }
  // selfUploadMultipartFieldsSchema strict → namespace/scope 字段一律拒收（scope 恒取信封头）。
  const parsed = selfUploadMultipartFieldsSchema.parse(names === undefined ? {} : { names });
  return { zip, names: parsed.names ?? null };
}

function readSelfJsonUpload(body: unknown): UploadZipPayload {
  const parsed = selfUploadJsonBodySchema.parse(body);
  const zip = Buffer.from(parsed.zip_base64, "base64");
  if (zip.byteLength > MAX_UPLOAD_ZIP_BYTES) {
    throw new UploadRequestError(
      413,
      "hub.upload_too_large",
      `zip exceeds ${MAX_UPLOAD_ZIP_BYTES} bytes`,
    );
  }
  return { zip, names: parsed.names ?? null };
}

export async function readSelfUploadPayload(request: FastifyRequest): Promise<UploadZipPayload> {
  if (request.isMultipart()) {
    return readSelfMultipartUpload(request);
  }
  return readSelfJsonUpload(request.body);
}

// 上传面错误归口：请求形状 400/413、坏 zip 400、存储未配置 503；其余抛回全局 handler。
export function replyUploadError(
  reply: FastifyReply,
  error: unknown,
  requestId: string | undefined,
): FastifyReply | null {
  if (error instanceof UploadRequestError) {
    return sendError(reply, error.statusCode, error.code, error.message, undefined, requestId);
  }
  if (error instanceof ZodError) {
    return sendZodError(reply, error, requestId);
  }
  if (error instanceof SkillValidationError) {
    return sendError(reply, 400, "hub.upload_invalid", error.message, undefined, requestId);
  }
  if (error instanceof PackageStoreError) {
    return sendError(reply, 503, "hub.package_store_unconfigured", error.message, undefined, requestId);
  }
  return null;
}

export function registerUploadRoutes(app: FastifyInstance, service: SkillUploadService): void {
  app.post(
    "/hub/admin/skills/upload/preview",
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: {
        tags: ["hub-admin"],
        summary: "上传预检：解包校验（不落库），返回候选清单与归属冲突",
      },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const payload = await readUploadPayload(request);
        const preview = await service.preview(payload.namespace, payload.zip);
        return sendData(reply, preview, 200, requestId);
      } catch (error) {
        const handled = replyUploadError(reply, error, requestId);
        if (handled !== null) {
          return handled;
        }
        request.log.error({ error }, "failed to preview skill upload");
        return sendError(reply, 500, "hub.upload_preview_failed", "上传预检失败", undefined, requestId);
      }
    },
  );

  app.post(
    "/hub/admin/skills/upload/confirm",
    {
      bodyLimit: UPLOAD_BODY_LIMIT,
      schema: {
        tags: ["hub-admin"],
        summary: "上传发布：逐项 S3 内容寻址包体 + Mongo upsert（允许部分成功）",
      },
    },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      try {
        const payload = await readUploadPayload(request);
        const results = await service.confirm(payload.namespace, payload.zip, payload.names);
        return sendData(reply, { namespace: payload.namespace, results }, 200, requestId);
      } catch (error) {
        const handled = replyUploadError(reply, error, requestId);
        if (handled !== null) {
          return handled;
        }
        request.log.error({ error }, "failed to confirm skill upload");
        return sendError(reply, 500, "hub.upload_confirm_failed", "上传发布失败", undefined, requestId);
      }
    },
  );

  app.get(
    "/hub/admin/skills/:scope/:name/revisions",
    { schema: { tags: ["hub-admin"], summary: "版本历史（append-only，revision 降序）" } },
    async (request, reply) => {
      const requestId = readRequestContext(request.headers).requestId;
      const params = scopeNameParamsSchema.safeParse(request.params);
      if (!params.success) {
        return sendZodError(reply, params.error, requestId);
      }
      const revisions = await service.revisions(params.data.scope, params.data.name);
      return sendData(reply, { revisions }, 200, requestId);
    },
  );
}
