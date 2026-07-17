import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { McpServerNotFoundError } from "../../domain/errors.js";
import { mcpConfigHash } from "../../domain/mcp-config-hash.js";
import type {
  McpGrantView,
  McpServerRepository,
  McpServerRevisionResolution,
  McpServerView,
  UpsertMcpServerInput,
} from "../../domain/mcp-repository.js";
import type { HubCollections, McpServerRecord } from "./mongo-client.js";

function nowMs(): number {
  return Date.now();
}

// 存量文档无 revision → 迁移语义：读侧按此版号补齐（纲领：首次读到无 revision 的活文档按 revision=1）。
const LEGACY_REVISION = 1;

function docRevision(doc: McpServerRecord): number {
  return typeof doc.revision === "number" ? doc.revision : LEGACY_REVISION;
}

function docConfigHash(doc: McpServerRecord): string {
  return mcpConfigHash({
    transport: doc.transport,
    url: doc.url,
    allowedTools: doc.allowed_tools,
    secretRef: doc.secret_ref,
  });
}

function toView(doc: McpServerRecord): McpServerView {
  return {
    scope: doc.scope,
    name: doc.name,
    revision: docRevision(doc),
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
// MCP-REVISION：活文档持当前 revision，内容每变 append 一格不可变 mcp_server_revisions 快照。
export class MongoMcpServerRepository implements McpServerRepository {
  private indexed = false;

  constructor(private readonly collections: HubCollections) {}

  private async ensureIndexes(): Promise<void> {
    if (this.indexed) {
      return;
    }
    await this.collections.mcpServers.createIndex({ scope: 1, name: 1 }, { unique: true });
    await this.collections.mcpServerRevisions.createIndex(
      { scope: 1, name: 1, revision: 1 },
      { unique: true },
    );
    this.indexed = true;
  }

  // append-only 快照落格：幂等（同 (scope,name,revision) 只落一次，行永不改写）。
  private async appendRevision(doc: McpServerRecord, revision: number): Promise<void> {
    await this.collections.mcpServerRevisions.updateOne(
      { scope: doc.scope, name: doc.name, revision },
      {
        $setOnInsert: {
          scope: doc.scope,
          name: doc.name,
          revision,
          config_hash: docConfigHash(doc),
          transport: doc.transport,
          url: doc.url,
          allowed_tools: doc.allowed_tools,
          secret_ref: doc.secret_ref,
          created_at: nowMs(),
        },
      },
      { upsert: true },
    );
  }

  // 迁移：读到无 revision 的活文档，按 revision=1 补齐活文档并 append 快照行（幂等）。
  // 返回补齐后的文档现况（含 revision），供读路直接用。
  private async ensureMigrated(doc: McpServerRecord): Promise<McpServerRecord> {
    if (typeof doc.revision === "number") {
      return doc;
    }
    const migrated: McpServerRecord = { ...doc, revision: LEGACY_REVISION };
    await this.appendRevision(migrated, LEGACY_REVISION);
    await this.collections.mcpServers.updateOne(
      { scope: doc.scope, name: doc.name },
      { $set: { revision: LEGACY_REVISION } },
    );
    return migrated;
  }

  // official + namespace 合并的有效池（namespace 覆盖同名，只出 enabled 且未软删），读侧顺手迁移存量。
  private async mergedActive(namespace: string): Promise<McpServerRecord[]> {
    await this.ensureIndexes();
    const active: McpServerRecord[] = [];
    const seen = new Set<string>();
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
        active.push(await this.ensureMigrated(doc));
      }
    }
    return active;
  }

  async listPool(namespace: string): Promise<McpServerView[]> {
    const active = await this.mergedActive(namespace);
    return active.map(toView);
  }

  async listOfficialCatalog(): Promise<McpServerView[]> {
    await this.ensureIndexes();
    // 运营目录：官方 scope 全量(含禁用),读侧顺手迁移存量,按 name 升序。
    const cards: McpServerView[] = [];
    const cursor = this.collections.mcpServers.find({ scope: OFFICIAL_SCOPE, deleted_at: null }).sort({ name: 1 });
    for await (const doc of cursor) {
      cards.push(toView(await this.ensureMigrated(doc)));
    }
    return cards;
  }

  async resolveGrants(namespace: string): Promise<McpGrantView[]> {
    const active = await this.mergedActive(namespace);
    return active.map((doc) => ({
      scope: doc.scope,
      name: doc.name,
      revision: docRevision(doc),
      config_hash: docConfigHash(doc),
    }));
  }

  async getRevisionSnapshot(
    scope: string,
    name: string,
    revision: number,
  ): Promise<McpServerRevisionResolution | null> {
    await this.ensureIndexes();
    // 存量快照缺失但活文档在 revision=1：读活文档时触发迁移补齐快照行，再取。
    const live = await this.collections.mcpServers.findOne({ scope, name });
    if (live !== null && typeof live.revision !== "number") {
      await this.ensureMigrated(live);
    }
    const row = await this.collections.mcpServerRevisions.findOne({ scope, name, revision });
    if (row === null) {
      // 未知 revision（从未落格 / 越界）：agent fail-closed 拒装。
      return null;
    }
    return {
      snapshot: {
        scope: row.scope,
        name: row.name,
        revision: row.revision,
        config_hash: row.config_hash,
        transport: row.transport,
        url: row.url,
        allowed_tools: row.allowed_tools,
        secret_ref: row.secret_ref,
      },
      // 活文档现况：disable/revoke 立即对旧会话生效（快照仍在，活文档说停就停）。
      live: {
        enabled: live !== null && live.enabled,
        deleted: live === null || live.deleted_at !== null,
      },
    };
  }

  async upsertServer(input: UpsertMcpServerInput): Promise<McpServerView> {
    await this.ensureIndexes();
    const existing = await this.collections.mcpServers.findOne({
      scope: input.scope,
      name: input.name,
    });
    const newHash = mcpConfigHash({
      transport: input.transport,
      url: input.url,
      allowedTools: input.allowedTools,
      secretRef: input.secretRef,
    });

    let revision: number;
    if (existing === null) {
      revision = 1;
    } else {
      const migrated = await this.ensureMigrated(existing);
      // 内容相同（config_hash 未变，含 secret handle 轮换不改 secret_ref 的情形）→ 幂等短路不 bump。
      // 内容变化 → revision+1。软删复活不改内容语义：仍按 hash 决定是否 bump。
      revision =
        docConfigHash(migrated) === newHash ? docRevision(migrated) : docRevision(migrated) + 1;
    }

    const written = await this.collections.mcpServers.findOneAndUpdate(
      { scope: input.scope, name: input.name },
      {
        $set: {
          revision,
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
    // 内容变化才是新 revision；内容相同的重注册指向原格，appendRevision 幂等短路（行永不改写）。
    await this.appendRevision(written, revision);
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
