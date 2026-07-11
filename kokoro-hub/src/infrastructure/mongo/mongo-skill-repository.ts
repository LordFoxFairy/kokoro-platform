import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { ConcurrentWriteError, SkillRequiredError } from "../../domain/errors.js";
import type {
  ActiveSkillSummary,
  OfficialFlagsInput,
  PoolCard,
  QuotaUsage,
  SkillHubRepository,
  SkillRevisionView,
  UpsertSkillInput,
  UpsertSkillResult,
} from "../../domain/repository.js";
import type { HubCollections } from "./mongo-client.js";

function nowMs(): number {
  return Date.now();
}

// SkillHubRepository 的 Mongo 实现——逐条对齐 agent/src/kokoro_agent/skills/hub.py
// 的 list_pool / set_enabled / set_official_flags / mark_deleted，双实现语义收敛。
export class MongoSkillRepository implements SkillHubRepository {
  private indexed = false;

  constructor(private readonly collections: HubCollections) {}

  private async ensureIndexes(): Promise<void> {
    if (this.indexed) {
      return;
    }
    await this.collections.skills.createIndex({ scope: 1, name: 1 }, { unique: true });
    await this.collections.state.createIndex({ namespace: 1, name: 1 }, { unique: true });
    await this.collections.revisions.createIndex({ scope: 1, name: 1, revision: -1 });
    this.indexed = true;
  }

  async listPool(namespace: string): Promise<PoolCard[]> {
    await this.ensureIndexes();
    const disabled = new Set<string>();
    for await (const doc of this.collections.state.find({ namespace, enabled: false })) {
      disabled.add(doc.name);
    }

    const cards: PoolCard[] = [];
    const seen = new Set<string>();
    // namespace 覆盖 official：先收自有包，再补官方位（同名不重复）。
    for (const scope of [namespace, OFFICIAL_SCOPE]) {
      const cursor = this.collections.skills
        .find(
          { scope, deleted_at: null },
          {
            projection: {
              name: 1,
              description: 1,
              content_hash: 1,
              official_enabled: 1,
              official_required: 1,
            },
          },
        )
        .sort({ name: 1 });
      for await (const doc of cursor) {
        const name = doc.name;
        if (seen.has(name)) {
          continue;
        }
        if (scope === OFFICIAL_SCOPE) {
          const required = Boolean(doc.official_required);
          if (!doc.official_enabled && !required) {
            continue;
          }
          if (disabled.has(name) && !required) {
            continue;
          }
        }
        cards.push({
          name,
          description: doc.description,
          content_hash: doc.content_hash,
          scope,
        });
        seen.add(name);
      }
    }
    return cards;
  }

  async setEnabled(namespace: string, name: string, enabled: boolean): Promise<void> {
    await this.ensureIndexes();
    const official = await this.collections.skills.findOne({
      scope: OFFICIAL_SCOPE,
      name,
      deleted_at: null,
    });
    if (official?.official_required && !enabled) {
      throw new SkillRequiredError(name);
    }
    await this.collections.state.updateOne(
      { namespace, name },
      { $set: { enabled, updated_at: nowMs() } },
      { upsert: true },
    );
  }

  async setOfficialFlags(name: string, flags: OfficialFlagsInput): Promise<void> {
    await this.ensureIndexes();
    const update: { official_enabled?: boolean; official_required?: boolean } = {};
    if (flags.enabled !== undefined) {
      update.official_enabled = flags.enabled;
    }
    if (flags.required !== undefined) {
      update.official_required = flags.required;
    }
    if (Object.keys(update).length === 0) {
      return;
    }
    await this.collections.skills.updateOne({ scope: OFFICIAL_SCOPE, name }, { $set: update });
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    await this.ensureIndexes();
    await this.collections.skills.updateOne({ scope, name }, { $set: { deleted_at: nowMs() } });
  }

  // 元数据 upsert（对齐 agent hub.py upsert）：hash 未变幂等短路；文档级 revision CAS 防并发写半截；
  // 真实写入后 append 一条 skill_revisions 历史行（附集合非事务，插入失败时包体/元数据已落，调用方按失败重试即可幂等）。
  async upsertSkill(input: UpsertSkillInput): Promise<UpsertSkillResult> {
    await this.ensureIndexes();
    const current = await this.collections.skills.findOne({ scope: input.scope, name: input.name });
    if (current !== null && current.content_hash === input.contentHash && current.deleted_at === null) {
      return { revision: current.revision, changed: false }; // 幂等：hash 未变不写。
    }
    const baseRevision = typeof current?.revision === "number" ? current.revision : 0;
    const revision = baseRevision + 1;
    // CAS：revision 匹配才写；竞争者先写则本次失败（fail-loud，调用方可重试）。
    const query =
      current !== null
        ? { scope: input.scope, name: input.name, revision: baseRevision }
        : { scope: input.scope, name: input.name };
    const written = await this.collections.skills.findOneAndUpdate(
      query,
      {
        $set: {
          description: input.description,
          skill_md: input.skillMd,
          files_manifest: input.filesManifest,
          file_count: input.fileCount,
          package_size: input.packageSize,
          content_hash: input.contentHash,
          package_ref: input.packageRef,
          source: input.source,
          revision,
          updated_at: nowMs(),
          deleted_at: null,
        },
        $setOnInsert: {
          scope: input.scope,
          name: input.name,
          official_enabled: true,
          official_required: false,
        },
      },
      { upsert: current === null, returnDocument: "after" },
    );
    if (written === null) {
      throw new ConcurrentWriteError(input.scope, input.name);
    }
    await this.collections.revisions.insertOne({
      scope: input.scope,
      name: input.name,
      revision,
      content_hash: input.contentHash,
      package_size: input.packageSize,
      source: input.source,
      created_at: nowMs(),
    });
    return { revision, changed: true };
  }

  async findActive(scope: string, name: string): Promise<ActiveSkillSummary | null> {
    await this.ensureIndexes();
    const doc = await this.collections.skills.findOne(
      { scope, name, deleted_at: null },
      { projection: { content_hash: 1, revision: 1, package_size: 1 } },
    );
    if (doc === null) {
      return null;
    }
    return { contentHash: doc.content_hash, revision: doc.revision, packageSize: doc.package_size };
  }

  async listRevisions(scope: string, name: string): Promise<SkillRevisionView[]> {
    await this.ensureIndexes();
    const rows = await this.collections.revisions
      .find({ scope, name }, { projection: { _id: 0 } })
      .sort({ revision: -1 })
      .toArray();
    return rows.map((row) => ({
      scope: row.scope,
      name: row.name,
      revision: row.revision,
      content_hash: row.content_hash,
      package_size: row.package_size,
      source: row.source,
      created_at: row.created_at,
    }));
  }

  async quotaUsage(namespace: string): Promise<QuotaUsage> {
    await this.ensureIndexes();
    const cursor = this.collections.skills.aggregate<{ count: number; bytes: number }>([
      { $match: { scope: namespace, deleted_at: null } },
      { $group: { _id: null, count: { $sum: 1 }, bytes: { $sum: "$package_size" } } },
    ]);
    const rows = await cursor.toArray();
    const row = rows[0];
    return {
      packageCount: row?.count ?? 0,
      packageBytes: row?.bytes ?? 0,
    };
  }
}
