import type { ReviewStatus } from "../contract/skill-curation-storage.js";

// 池卡片：与生成契约 SkillCard（name/description/content_hash）同形，附 scope 供管理面区分官方位与自有包。
export interface PoolCard {
  name: string;
  description: string;
  content_hash: string;
  scope: string;
}

// 官方目录卡（运营 admin 面）：列全部官方技能（不论上架/审核态,运营方要看全并处置）+ 运营位与审核态。
// 与 PoolCard（租户可用池）不同:这里是运营视角的官方目录治理视图。
export interface OfficialCatalogCard {
  name: string;
  description: string;
  content_hash: string;
  official_enabled: boolean;
  official_required: boolean;
  pinned: boolean;
  display_weight: number;
  category: string | null;
  review_status: ReviewStatus;
}

export interface OfficialFlagsInput {
  enabled?: boolean | undefined;
  required?: boolean | undefined;
}

// 运营位入参（管理面）：三个位都可选但至少一个（http 边界校验）；category 传 null = 清除分类。
export interface CurationInput {
  displayWeight?: number | undefined;
  pinned?: boolean | undefined;
  category?: string | null | undefined;
}

// 某 namespace 已上传包的原始占用（配额上限由 application 层从 env 注入合成视图）。
export interface QuotaUsage {
  packageCount: number;
  packageBytes: number;
}

// upsert 入参：files 校验/寻址/打包在 application 层完成，仓储只收元数据事实。
export interface UpsertSkillInput {
  scope: string;
  name: string;
  description: string;
  skillMd: string;
  filesManifest: { path: string; size: number }[];
  fileCount: number;
  packageSize: number;
  contentHash: string;
  packageRef: string;
  source: "deploy" | "upload" | "github";
}

export interface UpsertSkillResult {
  revision: number;
  // false = content_hash 未变的幂等短路（不写库、不落 revision 历史）。
  changed: boolean;
}

// 归属冲突检测 / 配额增量计算用的活跃文档摘要（未软删）。
export interface ActiveSkillSummary {
  contentHash: string;
  revision: number;
  packageSize: number;
}

// 版本历史行（skill_revisions 附集合，append-only）：真实写入才落一条，幂等短路不落。
export interface SkillRevisionView {
  scope: string;
  name: string;
  revision: number;
  content_hash: string;
  package_size: number;
  source: string;
  created_at: number;
}

export interface SkillHubRepository {
  // 该主体可用池：official（official_enabled ∧ 用户偏好未关；required 恒含）+ 本 namespace 自有包（覆盖同名 official）。
  listPool(namespace: string): Promise<PoolCard[]>;
  // 运营 admin 面：列全部官方技能（scope=official 且未软删,不论上架/审核态）+ 运营/审核字段,供后台治理。
  listOfficialCatalog(): Promise<OfficialCatalogCard[]>;
  // per-user 启停偏好（独立 skill_state 表，键 = namespace+name）；关闭 required 官方技能抛 SkillRequiredError。
  setEnabled(namespace: string, name: string, enabled: boolean): Promise<void>;
  // 官方位（管理面）：official_enabled=全局上架开关；official_required=恒注入且拒绝用户关闭。
  setOfficialFlags(name: string, flags: OfficialFlagsInput): Promise<void>;
  // 运营位（管理面，HUB-4）：pinned/display_weight 驱动池排序，category 为分类标签。
  // 目标不存在或已软删抛 SkillNotFoundError（路由 404）。
  setCuration(scope: string, name: string, input: CurationInput): Promise<void>;
  // 审核状态机（HUB-4，V1 上传自动 approved）：pending|approved|rejected；池查询只出 approved
  //（存量无字段 = 视为 approved，读侧 backfill）。目标缺失抛 SkillNotFoundError。
  setReviewStatus(scope: string, name: string, status: ReviewStatus): Promise<void>;
  // 软删：置 deleted_at，池与解析读路即刻不可见；包体永存不动（回滚零成本）。
  markDeleted(scope: string, name: string): Promise<void>;
  // 该 namespace 自有包占用合计（scope==namespace 且未软删）。
  quotaUsage(namespace: string): Promise<QuotaUsage>;
  // 元数据 upsert（revision CAS 对齐 agent hub.py）：hash 未变幂等短路；竞争落败抛 ConcurrentWriteError；
  // 真实写入顺带 append 一条 skill_revisions 历史行。
  upsertSkill(input: UpsertSkillInput): Promise<UpsertSkillResult>;
  // 活跃文档摘要（未软删）；不存在返回 null。preview 冲突检测与 confirm 配额增量用。
  findActive(scope: string, name: string): Promise<ActiveSkillSummary | null>;
  // 版本历史（append-only），revision 降序。
  listRevisions(scope: string, name: string): Promise<SkillRevisionView[]>;
}
