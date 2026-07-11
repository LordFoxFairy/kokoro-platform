import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { McpServerNotFoundError } from "../../domain/errors.js";
import type {
  McpServerRepository,
  McpServerView,
  UpsertMcpServerInput,
} from "../../domain/mcp-repository.js";
import type { HubCollections, McpServerRecord } from "./mongo-client.js";

function nowMs(): number {
  return Date.now();
}

function toView(doc: McpServerRecord): McpServerView {
  return {
    scope: doc.scope,
    name: doc.name,
    transport: doc.transport,
    url: doc.url,
    allowed_tools: doc.allowed_tools,
    secret_ref: doc.secret_ref,
    enabled: doc.enabled,
  };
}

// McpServerRepository 的 Mongo 实现——面语义与 MongoSkillRepository 同构
// （namespace 覆盖 official 同名 / 软删 deleted_at / 池只出活跃项），差异只在
// enabled 是文档级状态而非 per-user 偏好（MCP 是活的外部连接，天然少量）。
export class MongoMcpServerRepository implements McpServerRepository {
  private indexed = false;

  constructor(private readonly collections: HubCollections) {}

  private async ensureIndexes(): Promise<void> {
    if (this.indexed) {
      return;
    }
    await this.collections.mcpServers.createIndex({ scope: 1, name: 1 }, { unique: true });
    this.indexed = true;
  }

  async listPool(namespace: string): Promise<McpServerView[]> {
    await this.ensureIndexes();
    const views: McpServerView[] = [];
    const seen = new Set<string>();
    // namespace 覆盖 official：先收自有，再补官方位（同名不重复）。
    for (const scope of [namespace, OFFICIAL_SCOPE]) {
      const cursor = this.collections.mcpServers.find({ scope, deleted_at: null }).sort({ name: 1 });
      for await (const doc of cursor) {
        if (seen.has(doc.name)) {
          continue;
        }
        // 活跃文档即占名：禁用的自有 server 也遮蔽 official 同名，绝不静默回退到官方凭据。
        seen.add(doc.name);
        if (!doc.enabled) {
          continue;
        }
        views.push(toView(doc));
      }
    }
    return views;
  }

  async upsertServer(input: UpsertMcpServerInput): Promise<McpServerView> {
    await this.ensureIndexes();
    const written = await this.collections.mcpServers.findOneAndUpdate(
      { scope: input.scope, name: input.name },
      {
        $set: {
          transport: input.transport,
          url: input.url,
          allowed_tools: input.allowedTools,
          secret_ref: input.secretRef,
          updated_at: nowMs(),
          deleted_at: null, // 重注册复活软删
        },
        // enabled 只在首插默认 true：重注册更新定义，不翻已有启停位。
        $setOnInsert: { enabled: true },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (written === null) {
      // upsert + returnDocument:after 恒有文档；防御分支 fail-loud。
      throw new Error(`mcp server upsert returned no document for ${input.scope}/${input.name}`);
    }
    return toView(written);
  }

  async setEnabled(scope: string, name: string, enabled: boolean): Promise<void> {
    await this.ensureIndexes();
    const result = await this.collections.mcpServers.updateOne(
      { scope, name, deleted_at: null },
      { $set: { enabled, updated_at: nowMs() } },
    );
    if (result.matchedCount === 0) {
      throw new McpServerNotFoundError(scope, name);
    }
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    await this.ensureIndexes();
    await this.collections.mcpServers.updateOne({ scope, name }, { $set: { deleted_at: nowMs() } });
  }
}
