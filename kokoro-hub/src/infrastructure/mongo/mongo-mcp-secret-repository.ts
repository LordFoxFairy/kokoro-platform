import type {
  CreateSecretInput,
  McpSecretRepository,
  SecretListItem,
  StoredSecretCipher,
} from "../../domain/mcp-secret-repository.js";
import type { HubCollections, McpSecretRecord } from "./mongo-client.js";

function nowMs(): number {
  return Date.now();
}

// McpSecretRepository 的 Mongo 实现（HUB 半场）：明文绝不经此层。
// resolve 严格按 scope+handle 双条件过滤——跨 namespace 句柄一律不返回，不暴露存在性。
export class MongoMcpSecretRepository implements McpSecretRepository {
  private indexed = false;

  constructor(private readonly collections: HubCollections) {}

  private async ensureIndexes(): Promise<void> {
    if (this.indexed) {
      return;
    }
    // 句柄全局唯一（随机 128-bit 保证，unique 索引兜底碰撞）。
    await this.collections.mcpSecrets.createIndex({ handle: 1 }, { unique: true });
    // scope+handle 联合：resolve/softDelete 的 scope 隔离查询走此索引。
    await this.collections.mcpSecrets.createIndex({ scope: 1, handle: 1 });
    this.indexed = true;
  }

  async create(input: CreateSecretInput): Promise<void> {
    await this.ensureIndexes();
    const doc: McpSecretRecord = {
      scope: input.scope,
      handle: input.handle,
      name: input.name,
      ciphertext: input.ciphertext,
      key_id: input.keyId,
      created_at: nowMs(),
      deleted_at: null,
    };
    await this.collections.mcpSecrets.insertOne(doc);
  }

  async list(scope: string): Promise<SecretListItem[]> {
    await this.ensureIndexes();
    const cursor = this.collections.mcpSecrets
      .find({ scope, deleted_at: null })
      .sort({ created_at: 1 });
    const items: SecretListItem[] = [];
    for await (const doc of cursor) {
      // 只出句柄/命名/创建时间——密文与 key_id 绝不进列表视图。
      items.push({ handle: doc.handle, name: doc.name, createdAt: doc.created_at });
    }
    return items;
  }

  async softDelete(scope: string, handle: string): Promise<void> {
    await this.ensureIndexes();
    // 幂等：命中活跃项即软删；不存在/已删/跨 scope 静默通过（不暴露存在性）。
    await this.collections.mcpSecrets.updateOne(
      { scope, handle, deleted_at: null },
      { $set: { deleted_at: nowMs() } },
    );
  }

  async resolve(scope: string, handles: readonly string[]): Promise<StoredSecretCipher[]> {
    await this.ensureIndexes();
    if (handles.length === 0) {
      return [];
    }
    // scope + handle∈请求集 + 活跃：跨 namespace 句柄天然落选，绝不返回也不区分存在性。
    const cursor = this.collections.mcpSecrets.find({
      scope,
      handle: { $in: [...handles] },
      deleted_at: null,
    });
    const found: StoredSecretCipher[] = [];
    for await (const doc of cursor) {
      found.push({ handle: doc.handle, ciphertext: doc.ciphertext, keyId: doc.key_id });
    }
    return found;
  }
}
