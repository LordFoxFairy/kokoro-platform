// mcp_secrets 存储契约（MCP-SECRET HUB 半场，已收编主仓 contract/spec/storage.yaml 单源）：
// McpSecretDoc/MCP_SECRETS_COLLECTION 经 generate.py 生成进 ./storage.ts;本文件保留句柄正则与转发。
//
// 语义：
// - scope: 不透明 namespace（每 namespace 独占自己的 secret，绝不跨界解析）。
// - handle: 不透明句柄（srt_ 前缀 + 随机 hex）；对外只暴露它，绝不暴露值/密文。
// - name: 用户命名（管理面展示用）；ciphertext: AES-256-GCM 信封串（明文绝不落库）。
// - key_id: 加密所用主密钥指纹（轮换双读定位键）。
// - deleted_at: 软删毫秒时间戳；null = 活跃。

export {
  MCP_SECRETS_COLLECTION,
  mcpSecretDocSchema,
  type McpSecretDoc,
} from "./storage.js";

// 句柄形状：srt_ + 32 hex（128-bit crypto 随机，不透明、抗碰撞）。作为对外唯一暴露的 secret 标识。
export const SECRET_HANDLE_RE = /^srt_[0-9a-f]{32}$/;
