import type {
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
