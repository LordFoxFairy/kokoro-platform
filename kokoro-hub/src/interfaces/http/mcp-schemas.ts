import { z } from "zod";
import { MCP_TRANSPORTS } from "../../contract/mcp-storage.js";

// MCP server 名与 skill 名同一形状契约（小写/数字/连字符，2-64）；作为池键与 wire name。
export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

// 注册/更新体（POST /hub/admin/mcp/servers）。allowed_tools 空数组 = 不限制（对齐 agent 侧缺省全量）；
// 非空 = 白名单。schema 只校验请求类型/必填字段；secret_ref/url 字符串的安全合法性由
// admin admission 层统一映射为稳定错误码，并且必须在持久化前完成。
export const registerMcpServerBodySchema = z
  .object({
    scope: z.string().trim().min(1),
    name: z
      .string()
      .regex(MCP_SERVER_NAME_RE, "name must be lowercase alnum/hyphen, 2-64 chars"),
    transport: z.enum(MCP_TRANSPORTS),
    url: z.string().trim(),
    allowed_tools: z.array(z.string().trim().min(1)).max(200),
    secret_ref: z.string().trim().nullable().optional(),
  })
  .strict();

export type RegisterMcpServerBody = z.infer<typeof registerMcpServerBodySchema>;
