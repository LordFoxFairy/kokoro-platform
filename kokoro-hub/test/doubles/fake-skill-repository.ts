import { SkillRequiredError } from "../../src/domain/errors.js";
import type {
  OfficialFlagsInput,
  PoolCard,
  QuotaUsage,
  SkillHubRepository,
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
}
