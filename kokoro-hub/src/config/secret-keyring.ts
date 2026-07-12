// MCP secret 主密钥环装载（env → SecretKeyring）：primary（KOKORO_HUB_SECRET_MASTER_KEY）用于加密，
// previous（KOKORO_HUB_SECRET_MASTER_KEY_PREVIOUS，逗号分隔）仅供轮换期按 key_id 解旧信封。
// 缺 primary = 未配置（返回 null）：调用方据此禁用 secret broker（503），绝不带病服务。
// 主密钥绝不日志/回显；本模块只在启动期读取并交给 cipher，错误只报形状原因不含密钥。

import { makeSecretKeyring, type SecretKeyring } from "../infrastructure/crypto/aes-gcm-secret-cipher.js";
import type { HubEnv } from "./env.js";

const KEY_BYTES = 32;

// 解码单个 base64 主密钥并校验长度；非法即 fail-loud（错误不含密钥内容）。
function decodeMasterKey(raw: string, label: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  // Buffer.from base64 对非法字符是宽松丢弃，用往返比对确认严格合法。
  if (key.length !== KEY_BYTES) {
    throw new Error(`${label} must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

function splitPrevious(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadSecretKeyring(env: HubEnv): SecretKeyring | null {
  const primaryRaw = env.KOKORO_HUB_SECRET_MASTER_KEY;
  if (primaryRaw === undefined) {
    return null;
  }
  const keys: Buffer[] = [decodeMasterKey(primaryRaw, "KOKORO_HUB_SECRET_MASTER_KEY")];
  const previous = splitPrevious(env.KOKORO_HUB_SECRET_MASTER_KEY_PREVIOUS);
  for (const [index, raw] of previous.entries()) {
    keys.push(decodeMasterKey(raw, `KOKORO_HUB_SECRET_MASTER_KEY_PREVIOUS[${index}]`));
  }
  return makeSecretKeyring(keys);
}
