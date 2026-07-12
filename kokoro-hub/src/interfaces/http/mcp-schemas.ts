import { z } from "zod";
import { MCP_TRANSPORTS } from "../../contract/mcp-storage.js";

// MCP server 名与 skill 名同一形状契约（小写/数字/连字符，2-64）；作为池键与 wire name。
export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]{1,63}$/;

// 凭据引用形状（绝不明文）：env:VAR（部署环境变量整值占位，ADR-010/mcp-design 口径）
// 或 secret:path（secret 管理器引用，P2 网关预留）。形状外的任何字符串按明文凭据拒收。
export const MCP_SECRET_REF_RE = /^(env:[A-Z][A-Z0-9_]{0,127}|secret:[a-z0-9][a-z0-9/_-]{0,127})$/;

// server url：仅 http(s)，且禁止 userinfo（url 内嵌 user:pass 即明文凭据通道）。
const mcpUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      // .url() 已标记 invalid（zod dirty 状态下 refinement 仍会执行），此处不重复报。
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url must use http or https" });
    }
    if (parsed.username !== "" || parsed.password !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url must not embed credentials; use secret_ref instead",
      });
    }
  });

// 注册/更新体（POST /hub/admin/mcp/servers）。allowed_tools 空数组 = 不限制（对齐 agent 侧缺省全量）；
// 非空 = 白名单，名单外工具在 list/describe/call 全不可见（mcp-design §3）。
export const registerMcpServerBodySchema = z
  .object({
    scope: z.string().trim().min(1),
    name: z
      .string()
      .regex(MCP_SERVER_NAME_RE, "name must be lowercase alnum/hyphen, 2-64 chars"),
    transport: z.enum(MCP_TRANSPORTS),
    url: mcpUrlSchema,
    allowed_tools: z.array(z.string().trim().min(1)).max(200),
    secret_ref: z
      .string()
      .regex(
        MCP_SECRET_REF_RE,
        "secret_ref must be an env:VAR or secret:path reference; plaintext credentials are rejected",
      )
      .nullable()
      .optional(),
  })
  .strict();

export type RegisterMcpServerBody = z.infer<typeof registerMcpServerBodySchema>;
