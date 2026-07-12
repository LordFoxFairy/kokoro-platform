// MCP secret 仓储契约（HUB 半场）：明文绝不经此层——create 只收已加密的 ciphertext+keyId，
// resolve 只吐 ciphertext+keyId 交上层用 cipher 解密。列表面绝不含密文。

// 列表视图（self 管理面）：只出句柄/命名/创建时间，绝不含值或密文。
export interface SecretListItem {
  handle: string;
  name: string;
  createdAt: number;
}

// resolve 命中项（runtime 面）：交给 cipher 解密的最小材料，含 key_id 以支持轮换双读。
export interface StoredSecretCipher {
  handle: string;
  ciphertext: string;
  keyId: string;
}

// 写入入参：ciphertext 已在应用层用 cipher 封好，仓储只落库，绝不见明文。
export interface CreateSecretInput {
  scope: string;
  handle: string;
  name: string;
  ciphertext: string;
  keyId: string;
}

export interface McpSecretRepository {
  // 新建：句柄全局唯一（由随机保证），落一条活跃记录。
  create(input: CreateSecretInput): Promise<void>;
  // 该 namespace 活跃 secret 列表（不含值/密文），按 created_at 升序。
  list(scope: string): Promise<SecretListItem[]>;
  // 软删：置 deleted_at，即刻不可解析/不可见；幂等（不存在静默通过）。仅限本 scope。
  softDelete(scope: string, handle: string): Promise<void>;
  // 按句柄批量取密文材料——严格限定 scope：其他 namespace 的句柄一律不返回
  // （跨 namespace 不可解析，也不暴露存在性）。仅返回活跃项。
  resolve(scope: string, handles: readonly string[]): Promise<StoredSecretCipher[]>;
}
