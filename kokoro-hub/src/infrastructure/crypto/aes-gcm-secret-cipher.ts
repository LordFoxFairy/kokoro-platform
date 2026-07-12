import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  type EncryptedSecret,
  type SecretCipher,
  SecretDecryptError,
} from "../../domain/secret-cipher.js";

// 信封版本前缀：形状/算法演进时递增，decrypt 拒绝未知版本（防降级解析）。
const ENVELOPE_VERSION = "v1";
// GCM 标准 96-bit iv；每次加密独立随机，绝不复用。
const IV_BYTES = 12;
const KEY_BYTES = 32; // AES-256
const GCM_TAG_BYTES = 16;

// 主密钥指纹作 key_id：sha256(key) 前 16 hex。单向、稳定、可安全日志；
// 由密钥自身派生，轮换无需额外 id 簿记（新增密钥即得新 key_id）。
export function keyFingerprint(key: Buffer): string {
  return `k_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

// 密钥环：primary 用于加密（新写），全体（primary + 历史）用于解密（双读）。
export interface SecretKeyring {
  primaryKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

// 从若干 32B 密钥构造密钥环：第一个为 primary，其余为历史解密密钥。
// 空数组 = 未配置（调用方应据此禁用 secret broker，落 503 而非带病服务）。
export function makeSecretKeyring(keys: readonly Buffer[]): SecretKeyring | null {
  if (keys.length === 0) {
    return null;
  }
  const ring = new Map<string, Buffer>();
  for (const key of keys) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`secret master key must be ${KEY_BYTES} bytes, got ${key.length}`);
    }
    ring.set(keyFingerprint(key), key);
  }
  const primary = keys[0];
  if (primary === undefined) {
    return null;
  }
  return { primaryKeyId: keyFingerprint(primary), keys: ring };
}

// AES-256-GCM 信封加密（MCP-SECRET V1）：密钥经 env 主密钥密钥环，
// 生产可换 KMS 实现同一 SecretCipher 端口。密文串形状 `v1:ivB64:tagB64:ctB64`。
export class AesGcmSecretCipher implements SecretCipher {
  constructor(private readonly keyring: SecretKeyring) {
    const primary = keyring.keys.get(keyring.primaryKeyId);
    if (primary === undefined) {
      throw new Error("secret keyring primary key id not present in keyring");
    }
  }

  encrypt(plaintext: string): EncryptedSecret {
    const key = this.keyring.keys.get(this.keyring.primaryKeyId);
    if (key === undefined) {
      // 构造器已校验；防御分支 fail-loud（绝不静默明文落库）。
      throw new Error("secret keyring primary key missing at encrypt time");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ciphertext = [
      ENVELOPE_VERSION,
      iv.toString("base64"),
      tag.toString("base64"),
      ct.toString("base64"),
    ].join(":");
    return { ciphertext, keyId: this.keyring.primaryKeyId };
  }

  decrypt(secret: EncryptedSecret): string {
    const key = this.keyring.keys.get(secret.keyId);
    if (key === undefined) {
      throw new SecretDecryptError("unknown key id");
    }
    const parts = secret.ciphertext.split(":");
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new SecretDecryptError("malformed envelope");
    }
    const iv = Buffer.from(parts[1] ?? "", "base64");
    const tag = Buffer.from(parts[2] ?? "", "base64");
    const ct = Buffer.from(parts[3] ?? "", "base64");
    if (iv.length !== IV_BYTES || tag.length !== GCM_TAG_BYTES) {
      throw new SecretDecryptError("malformed envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    try {
      const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      // GCM 认证失败（密文/标签被篡改或错密钥）：统一错误面，绝不回显密文。
      throw new SecretDecryptError("authentication failed");
    }
  }
}
