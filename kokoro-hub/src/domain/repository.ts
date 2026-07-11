// 池卡片：与生成契约 SkillCard（name/description/content_hash）同形，附 scope 供管理面区分官方位与自有包。
export interface PoolCard {
  name: string;
  description: string;
  content_hash: string;
  scope: string;
}

export interface OfficialFlagsInput {
  enabled?: boolean | undefined;
  required?: boolean | undefined;
}

// 某 namespace 已上传包的原始占用（配额上限由 application 层从 env 注入合成视图）。
export interface QuotaUsage {
  packageCount: number;
  packageBytes: number;
}

export interface SkillHubRepository {
  // 该主体可用池：official（official_enabled ∧ 用户偏好未关；required 恒含）+ 本 namespace 自有包（覆盖同名 official）。
  listPool(namespace: string): Promise<PoolCard[]>;
  // per-user 启停偏好（独立 skill_state 表，键 = namespace+name）；关闭 required 官方技能抛 SkillRequiredError。
  setEnabled(namespace: string, name: string, enabled: boolean): Promise<void>;
  // 官方位（管理面）：official_enabled=全局上架开关；official_required=恒注入且拒绝用户关闭。
  setOfficialFlags(name: string, flags: OfficialFlagsInput): Promise<void>;
  // 软删：置 deleted_at，池与解析读路即刻不可见；包体永存不动（回滚零成本）。
  markDeleted(scope: string, name: string): Promise<void>;
  // 该 namespace 自有包占用合计（scope==namespace 且未软删）。
  quotaUsage(namespace: string): Promise<QuotaUsage>;
}
