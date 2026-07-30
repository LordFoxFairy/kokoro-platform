import { z } from "zod";
import { SECRET_HANDLE_RE } from "../../contract/mcp-secret-storage.js";

// 单条 secret 值上限：secret 是短凭据（token/key），非文档；8KiB 足量且挡住误传大 blob。
const MAX_SECRET_VALUE_BYTES = 8 * 1024;
// 单次 resolve 句柄数上限：装配期一次批解，挡住异常大批量。
const MAX_RESOLVE_HANDLES = 100;

// self 面创建体：scope 恒取信封头（strict → body 带 scope/namespace 即 400 伪造）。
// value 只进不出：创建后即加密落库，响应只回句柄。
export const createSecretBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    value: z.string().min(1).refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_SECRET_VALUE_BYTES,
      `value must be at most ${MAX_SECRET_VALUE_BYTES} UTF-8 bytes`,
    ),
  })
  .strict();

export type CreateSecretBody = z.infer<typeof createSecretBodySchema>;

// self 面删除路径参数：句柄形状钉死（srt_ + 32 hex），非法即 400 不进仓储。
export const secretHandleParamsSchema = z
  .object({
    handle: z.string().regex(SECRET_HANDLE_RE, "handle must be an srt_ opaque secret handle"),
  })
  .strict();

// runtime 面解析体：namespace 由已验 runtime caller 传入（同 /hub/runtime/resolve 口径）；
// handles 全为不透明句柄形状，去重后批解。跨 namespace 句柄在仓储层落选（不泄露存在性）。
export const resolveSecretsBodySchema = z
  .object({
    namespace: z.string().trim().min(1),
    handles: z
      .array(z.string().regex(SECRET_HANDLE_RE, "each handle must be an srt_ opaque secret handle"))
      .min(1)
      .max(MAX_RESOLVE_HANDLES),
  })
  .strict();

export type ResolveSecretsBody = z.infer<typeof resolveSecretsBodySchema>;
