// Secret 加解密端口（KMS port，MCP-SECRET HUB 半场）：明文只进不出。
// 上层（McpSecretService）只依赖此窄协议，不感知底层是 env 主密钥还是云 KMS；
// V1 实现 = AesGcmSecretCipher（env 主密钥），生产可换 KMS 实现而不动调用方。

// 密文信封：ciphertext 是自描述串（含版本/iv/tag/密文，绝不含明文），
// key_id 是所用主密钥指纹——分列存储便于轮换期按 key_id 定位与批量重封。
export interface EncryptedSecret {
  ciphertext: string;
  keyId: string;
}

export interface SecretCipher {
  // 明文进、密文信封出；同一明文每次加密因随机 iv 而密文不同（GCM 语义）。
  encrypt(plaintext: string): EncryptedSecret;
  // 按信封 key_id 选主密钥解密（双读轮换：旧 key_id 仍可解，新写用主 key）；
  // 认证失败/未知 key_id/信封损坏一律抛 SecretDecryptError，错误信息绝不含密文或明文。
  decrypt(secret: EncryptedSecret): string;
}

// 解密失败面（认证标签不符 / 未知 key_id / 信封形状损坏）：统一错误面，
// message 恒为固定原因串，绝不回显密文、明文或密钥，避免旁路泄漏。
export class SecretDecryptError extends Error {
  constructor(reason: string) {
    super(`secret decrypt failed: ${reason}`);
    this.name = "SecretDecryptError";
  }
}
