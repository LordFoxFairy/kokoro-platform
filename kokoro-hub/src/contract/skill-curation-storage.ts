// Hub owns its private Mongo collection names and curation persistence shape. These are not a
// cross-service wire contract and must not be generated from Root's retired storage corpus.
//
// 语义：
// - display_weight: 运营排序权重，越大越靠前；缺省 0。
// - pinned: 置顶位，排序最高优先；缺省 false。
// - category: 运营分类标签（自由字符串）；null = 未分类。
// - review_status: 审核三态 pending|approved|rejected；V1 上传 confirm 自动 approved（字段先落，
//   为后续人审留位）。池查询只出 approved；存量文档无字段 = 视为 approved（backfill 在读侧）。

import { z } from "zod";

export const SKILLS_COLLECTION = "skills";
export const SKILL_STATE_COLLECTION = "skill_state";
export const SKILL_REVISIONS_COLLECTION = "skill_revisions";

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const skillCurationFieldsSchema = z
  .object({
    display_weight: z.number().int(),
    pinned: z.boolean(),
    category: z.string().min(1).nullable(),
    review_status: z.enum(REVIEW_STATUSES),
  })
  .strict();
export type SkillCurationFields = z.infer<typeof skillCurationFieldsSchema>;

// 存量文档缺字段时的读侧缺省(backfill):运营零位+自动过审。
export const SKILL_CURATION_DEFAULTS: SkillCurationFields = {
  display_weight: 0,
  pinned: false,
  category: null,
  review_status: "approved",
};
