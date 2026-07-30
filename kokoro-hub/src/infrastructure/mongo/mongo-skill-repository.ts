import { SKILL_CURATION_DEFAULTS, type ReviewStatus } from "../../contract/skill-curation-storage.js";
import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { ConcurrentWriteError, SkillNotFoundError, SkillRequiredError } from "../../domain/errors.js";
import type {
  ActiveSkillSummary,
  CurationInput,
  OfficialCatalogCard,
  OfficialFlagsInput,
  PoolCard,
  QuotaUsage,
  SkillHubRepository,
  SkillRevisionView,
  UpsertSkillInput,
  UpsertSkillResult,
} from "../../domain/repository.js";
import type { HubCollections, SkillRecord } from "./mongo-client.js";

function nowMs(): number {
  return Date.now();
}

// SkillHubRepository 的 Hub 私有 Mongo 实现；跨仓消费者只能走正式 RPC 边界。
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

    // 运营排序键随卡片收集（不进对外卡片形状，池卡片契约 name/description/content_hash/scope 不变）。
    const ranked: { card: PoolCard; pinned: boolean; weight: number }[] = [];
    const seen = new Set<string>();
    // namespace 覆盖 official：先收自有包，再补官方位（同名不重复）。
    // 审核过滤：只出 approved；存量无 review_status 字段 = 视为 approved（backfill 读侧）。
    for (const scope of [namespace, OFFICIAL_SCOPE]) {
      const cursor = this.collections.skills
        .find(
          { scope, deleted_at: null, review_status: { $nin: ["pending", "rejected"] } },
          {
            projection: {
              name: 1,
              description: 1,
              content_hash: 1,
              official_enabled: 1,
              official_required: 1,
              display_weight: 1,
              pinned: 1,
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
        ranked.push({
          card: {
            name,
            description: doc.description,
            content_hash: doc.content_hash,
            scope,
          },
          pinned: doc.pinned ?? SKILL_CURATION_DEFAULTS.pinned,
          weight: doc.display_weight ?? SKILL_CURATION_DEFAULTS.display_weight,
        });
        seen.add(name);
      }
    }
    // 运营排序：pinned desc → display_weight desc → name asc。
    ranked.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (a.weight !== b.weight) {
        return b.weight - a.weight;
      }
      // 与 Mongo {name:1} 同为码位序，不用 localeCompare（避免 locale 依赖的次序漂移）。
      return a.card.name < b.card.name ? -1 : a.card.name > b.card.name ? 1 : 0;
    });
    return ranked.map((entry) => entry.card);
  }

  // 运营 admin 面:列全部官方技能（scope=official 且未软删,不论上架/审核态——运营方要看全并处置）。
  // 返回运营/审核字段;排序 pinned desc → display_weight desc → name asc（与租户池一致）。
  async listOfficialCatalog(): Promise<OfficialCatalogCard[]> {
    await this.ensureIndexes();
    const cards: OfficialCatalogCard[] = [];
    const cursor = this.collections.skills.find(
      { scope: OFFICIAL_SCOPE, deleted_at: null },
      {
        projection: {
          name: 1,
          description: 1,
          content_hash: 1,
          official_enabled: 1,
          official_required: 1,
          display_weight: 1,
          pinned: 1,
          category: 1,
          review_status: 1,
        },
      },
    );
    for await (const doc of cursor) {
      cards.push({
        name: doc.name,
        description: doc.description,
        content_hash: doc.content_hash,
        official_enabled: Boolean(doc.official_enabled),
        official_required: Boolean(doc.official_required),
        pinned: doc.pinned ?? SKILL_CURATION_DEFAULTS.pinned,
        display_weight: doc.display_weight ?? SKILL_CURATION_DEFAULTS.display_weight,
        category: doc.category ?? null,
        // 存量无字段 = 视为 approved（与池读侧 backfill 一致）。
        review_status: (doc.review_status ?? "approved") as ReviewStatus,
      });
    }
    cards.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.display_weight !== b.display_weight) return b.display_weight - a.display_weight;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
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

  // 运营位（HUB-4）：pinned/display_weight 驱动池排序；目标须为活跃文档（软删/缺失 = 404 语义）。
  async setCuration(scope: string, name: string, input: CurationInput): Promise<void> {
    await this.ensureIndexes();
    const update: Partial<Pick<SkillRecord, "display_weight" | "pinned" | "category">> = {};
    if (input.displayWeight !== undefined) {
      update.display_weight = input.displayWeight;
    }
    if (input.pinned !== undefined) {
      update.pinned = input.pinned;
    }
    if (input.category !== undefined) {
      update.category = input.category;
    }
    if (Object.keys(update).length === 0) {
      return;
    }
    const result = await this.collections.skills.updateOne(
      { scope, name, deleted_at: null },
      { $set: { ...update, updated_at: nowMs() } },
    );
    if (result.matchedCount === 0) {
      throw new SkillNotFoundError(scope, name);
    }
  }

  // 审核状态机（HUB-4）：三态直写；池查询读侧过滤非 approved。
  async setReviewStatus(scope: string, name: string, status: ReviewStatus): Promise<void> {
    await this.ensureIndexes();
    const result = await this.collections.skills.updateOne(
      { scope, name, deleted_at: null },
      { $set: { review_status: status, updated_at: nowMs() } },
    );
    if (result.matchedCount === 0) {
      throw new SkillNotFoundError(scope, name);
    }
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
          // V1 审核自动过：每次真实写入（新内容 = 新审核对象）都置 approved；人审接入后改 pending。
          review_status: "approved" as const,
        },
        $setOnInsert: {
          scope: input.scope,
          name: input.name,
          official_enabled: true,
          official_required: false,
          // 运营位缺省（仅首插；升版本保留运营已设值）。
          display_weight: SKILL_CURATION_DEFAULTS.display_weight,
          pinned: SKILL_CURATION_DEFAULTS.pinned,
          category: SKILL_CURATION_DEFAULTS.category,
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
