// 包体存储位形（ADR-009）：session/agent/hub 三侧读同一份 KOKORO_WORKSPACE_CONFIG yaml，
// hub 只消费其中 hub 节（skills 包体权威源）。缺文件或缺 hub 节 = 包体存储未配置——
// 对齐 agent load_storage_file 语义（None = hub 不可用），上传 confirm 面 503 fail-loud。

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const localSchema = z.object({ type: z.literal("local"), root: z.string().min(1) }).strict();

// 凭据不进配置文件（env/secret 注入），yaml 只声明形态与非敏感参数。
const s3Schema = z
  .object({
    type: z.literal("s3"),
    endpoint: z.string().min(1),
    bucket: z.string().min(1),
    region: z.string().min(1).default("us-east-1"),
    // minio 等自托管 S3 兼容端点必须 path-style。
    force_path_style: z.boolean().default(true),
  })
  .strict();

export const storeLocationSchema = z.discriminatedUnion("type", [localSchema, s3Schema]);
export type StoreLocation = z.infer<typeof storeLocationSchema>;

// 与 agent StorageFile / session storageFileSchema 同形：hub 只取 hub 节，其余节容忍不消费。
const storageFileSchema = z
  .object({
    workspace: storeLocationSchema,
    hub: storeLocationSchema.optional(),
    deliveries: storeLocationSchema.optional(),
  })
  .strict();

export type StorageFileConfig = z.infer<typeof storageFileSchema>;

export function loadHubStoreLocation(configPath: string | undefined): StoreLocation | null {
  if (configPath === undefined || configPath === "") {
    return null;
  }
  // 显式给了配置就以它为完整声明：文件不可读/形状非法 fail-loud，不带病服务。
  const raw: unknown = parseYaml(readFileSync(configPath, "utf8"));
  return storageFileSchema.parse(raw).hub ?? null;
}
