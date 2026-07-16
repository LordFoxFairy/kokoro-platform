import type { ReviewStatus } from "../contract/skill-curation-storage.js";
import type {
  CurationInput,
  OfficialCatalogCard,
  OfficialFlagsInput,
  PoolCard,
  SkillHubRepository,
} from "../domain/repository.js";

// 配额上限（env 配置），与占用合成对外视图；snake_case 与 skills 线上契约同风格。
export interface QuotaLimits {
  maxPackages: number;
  maxBytes: number;
}

export interface QuotaView {
  namespace: string;
  package_count: number;
  package_bytes: number;
  max_packages: number;
  max_bytes: number;
}

export class SkillHubService {
  constructor(
    private readonly repository: SkillHubRepository,
    private readonly quotaLimits: QuotaLimits,
  ) {}

  async listPool(namespace: string): Promise<PoolCard[]> {
    return this.repository.listPool(namespace);
  }

  // 运营 admin 面:全部官方技能目录（治理视图,不论上架/审核态）。
  async listOfficialCatalog(): Promise<OfficialCatalogCard[]> {
    return this.repository.listOfficialCatalog();
  }

  // required 官方技能拒关由仓储抛 SkillRequiredError，路由映射 409。
  async setEnabled(namespace: string, name: string, enabled: boolean): Promise<void> {
    await this.repository.setEnabled(namespace, name, enabled);
  }

  async setOfficialFlags(name: string, flags: OfficialFlagsInput): Promise<void> {
    await this.repository.setOfficialFlags(name, flags);
  }

  async markDeleted(scope: string, name: string): Promise<void> {
    await this.repository.markDeleted(scope, name);
  }

  // 运营位（HUB-4）：目标缺失/软删由仓储抛 SkillNotFoundError，路由映射 404。
  async setCuration(scope: string, name: string, input: CurationInput): Promise<void> {
    await this.repository.setCuration(scope, name, input);
  }

  // 审核状态机（HUB-4）：pending|approved|rejected；池查询只出 approved。
  async setReviewStatus(scope: string, name: string, status: ReviewStatus): Promise<void> {
    await this.repository.setReviewStatus(scope, name, status);
  }

  async quota(namespace: string): Promise<QuotaView> {
    const usage = await this.repository.quotaUsage(namespace);
    return {
      namespace,
      package_count: usage.packageCount,
      package_bytes: usage.packageBytes,
      max_packages: this.quotaLimits.maxPackages,
      max_bytes: this.quotaLimits.maxBytes,
    };
  }
}
