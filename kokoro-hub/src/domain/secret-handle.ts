import { randomBytes } from "node:crypto";
import { SECRET_HANDLE_RE } from "../contract/mcp-secret-storage.js";

// 不透明 secret 句柄：srt_ 前缀 + 128-bit crypto 随机 hex。抗碰撞、不含任何用户/命名语义，
// 是 secret 对外唯一暴露的标识（值与密文绝不外泄）。
export function generateSecretHandle(): string {
  return `srt_${randomBytes(16).toString("hex")}`;
}

export function isSecretHandle(value: string): boolean {
  return SECRET_HANDLE_RE.test(value);
}
