import { SkillRequiredError } from "../../src/domain/errors.js";
import type {
  ActiveSkillSummary,
  OfficialFlagsInput,
  PoolCard,
  QuotaUsage,
  SkillHubRepository,
  SkillRevisionView,
  UpsertSkillInput,
  UpsertSkillResult,
} from "../../src/domain/repository.js";

// 服务层单测用的内存替身（test-only；生产只用真 Mongo 实现）。
export class FakeSkillRepository implements SkillHubRepository {
  pool: PoolCard[] = [];
  usage: QuotaUsage = { packageCount: 0, packageBytes: 0 };
  readonly requiredNames = new Set<string>();
  readonly enabledCalls: { namespace: string; name: string; enabled: boolean }[] = [];
  readonly officialCalls: { name: string; flags: OfficialFlagsInput }[] = [];
  readonly deletedCalls: { scope: string; name: string }[] = [];

  async listPool(_namespace: string): Promise<PoolCard[]> {
    return this.pool;
  }

  async setEnabled(namespace: string, name: string, enabled: boolean): Promise<void> {
    if (!enabled && this.requiredNames.has(name)) {
      throw new SkillRequiredError(name);
    }
    this.enabledCalls.push({ namespace, name, enabled });
  }

  async setOfficialFlags(name: string, flags: OfficialFlagsInput): Promise<void> {
    this.officialCalls.push({ name, flags });
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    this.deletedCalls.push({ scope, name });
  }

  async quotaUsage(_namespace: string): Promise<QuotaUsage> {
    return this.usage;
  }

  // --- HUB-2 上传写面（内存语义与 Mongo 实现同构：CAS 幂等、revision 递增、历史 append-only）---

  readonly activeSkills = new Map<string, ActiveSkillSummary>();
  readonly revisionRows: SkillRevisionView[] = [];
  readonly upsertCalls: UpsertSkillInput[] = [];
  failNextUpsertWith: Error | null = null;

  private static key(scope: string, name: string): string {
    return `${scope}/${name}`;
  }

  seedActive(scope: string, name: string, summary: ActiveSkillSummary): void {
    this.activeSkills.set(FakeSkillRepository.key(scope, name), summary);
  }

  async upsertSkill(input: UpsertSkillInput): Promise<UpsertSkillResult> {
    if (this.failNextUpsertWith !== null) {
      const error = this.failNextUpsertWith;
      this.failNextUpsertWith = null;
      throw error;
    }
    this.upsertCalls.push(input);
    const key = FakeSkillRepository.key(input.scope, input.name);
    const existing = this.activeSkills.get(key);
    if (existing !== undefined && existing.contentHash === input.contentHash) {
      return { revision: existing.revision, changed: false };
    }
    const revision = (existing?.revision ?? 0) + 1;
    this.activeSkills.set(key, {
      contentHash: input.contentHash,
      revision,
      packageSize: input.packageSize,
    });
    this.revisionRows.push({
      scope: input.scope,
      name: input.name,
      revision,
      content_hash: input.contentHash,
      package_size: input.packageSize,
      source: input.source,
      created_at: Date.now(),
    });
    return { revision, changed: true };
  }

  async findActive(scope: string, name: string): Promise<ActiveSkillSummary | null> {
    return this.activeSkills.get(FakeSkillRepository.key(scope, name)) ?? null;
  }

  async listRevisions(scope: string, name: string): Promise<SkillRevisionView[]> {
    return this.revisionRows
      .filter((row) => row.scope === scope && row.name === name)
      .sort((a, b) => b.revision - a.revision);
  }
}
