// mcp_servers 注册凭据引用（secret_ref）换轨（MCP-SECRET 半场 item 3）。
//
// 门态说明：本模块的收紧逻辑对应 self 面 MCP 注册（现恒 503 fail-closed，见 self-routes.ts）。
// 逻辑先落 + 单测覆盖；待 HUB-CONSIST 跨仓一致后开门时，self 注册 handler 直接消费本模块——
// "门后即生效"。admin schema 只守 string/null 请求形状；具体引用形状与 allowlist 在活跃
// register handler 的 admission 层校验，以保证非法字符串得到稳定业务错误码而不是 request.invalid。
//
// 新模型（D1 不留兼容轴，secret:path 旧留位不再进新面）：
// - self 面：secret_ref 只接受 `handle:srt_...`，且 handle 须∈本 namespace（归属校验在 handler，走仓储）。
// - admin/official 面：`env:VAR` 允许，且 VAR∈部署 allowlist（KOKORO_HUB_ENV_REF_ALLOWLIST）。

import { z } from "zod";
import { MCP_SERVER_NAME_RE } from "./mcp-schemas.js";
import { MCP_TRANSPORTS } from "../../contract/mcp-storage.js";

// self 面凭据引用：仅 handle: 形状（srt_ + 32 hex）。env:/secret:/明文一律拒收。
export const SELF_SECRET_REF_RE = /^handle:srt_[0-9a-f]{32}$/;
// env 引用形状（admin/official 面）：env:VAR，VAR 为大写下划线环境变量名。
const ENV_REF_RE = /^env:([A-Z][A-Z0-9_]{0,127})$/;

export type ParsedSecretRef =
  | { kind: "handle"; handle: string }
  | { kind: "env"; varName: string }
  | { kind: "invalid" };

// 解析 secret_ref 为受控种类。srt_ 句柄 / env:VAR 之外（含旧 secret:path、明文）一律 invalid。
export function parseSecretRef(ref: string): ParsedSecretRef {
  if (SELF_SECRET_REF_RE.test(ref)) {
    return { kind: "handle", handle: ref.slice("handle:".length) };
  }
  const envMatch = ENV_REF_RE.exec(ref);
  if (envMatch !== null && envMatch[1] !== undefined) {
    return { kind: "env", varName: envMatch[1] };
  }
  return { kind: "invalid" };
}

// 解析部署 env 引用白名单（逗号分隔 VAR 名）；空/缺省 = 空集（任何 env: 引用都不在表 → 拒）。
export function parseEnvRefAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) {
    return new Set();
  }
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return new Set(names);
}

// admin/official 面 env: 引用准入：VAR 须在部署 allowlist 内，否则 400（不在表即拒）。
export function isEnvRefAllowed(varName: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(varName);
}

// self 面 url：仅 https，且禁止 userinfo（内嵌凭据通道）。http/localhost 不在 self 面开（见 mcp-url-guard）。
const selfMcpUrlSchema = z
  .string()
  .trim()
  .url()
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "self mcp url must use https" });
    }
    if (parsed.username !== "" || parsed.password !== "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "url must not embed credentials; use a handle secret_ref instead",
      });
    }
  });

// self 面 MCP 注册体（门后生效）：scope 恒取信封头（不进 body），secret_ref 仅 handle: 形状。
// url shape（https/no-userinfo）在此同步校验；DNS/私网 IP 预校验在 handler 走 mcp-url-guard。
export const selfRegisterMcpServerBodySchema = z
  .object({
    name: z.string().regex(MCP_SERVER_NAME_RE, "name must be lowercase alnum/hyphen, 2-64 chars"),
    transport: z.enum(MCP_TRANSPORTS),
    url: selfMcpUrlSchema,
    allowed_tools: z.array(z.string().trim().min(1)).max(200),
    secret_ref: z
      .string()
      .regex(SELF_SECRET_REF_RE, "self secret_ref must be a handle:srt_... reference")
      .nullable()
      .optional(),
  })
  .strict();

export type SelfRegisterMcpServerBody = z.infer<typeof selfRegisterMcpServerBodySchema>;
