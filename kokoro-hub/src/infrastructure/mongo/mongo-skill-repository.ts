import { OFFICIAL_SCOPE } from "../../domain/constants.js";
import { SkillRequiredError } from "../../domain/errors.js";
import type {
  OfficialFlagsInput,
  PoolCard,
  QuotaUsage,
  SkillHubRepository,
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
