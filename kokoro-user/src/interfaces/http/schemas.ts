import { z } from "zod";

export const ensureUserRequestSchema = z
  .object({
    externalUserId: z.string().min(1),
    email: z.string().trim().toLowerCase().email().optional(),
    displayName: z.string().min(1).optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();

export const ownerActiveParamsSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

// GET /owners/:ownerKind/:ownerId/active 对外响应契约：credit 等下游经包入口 import 本 schema 消费，不手抄形状。
export const ownerActiveResponseSchema = z.object({ active: z.boolean() });
export type OwnerActiveResponse = z.infer<typeof ownerActiveResponseSchema>;

export const userParamsSchema = z
  .object({
    userId: z.string().min(1),
  })
  .strict();

export const teamParamsSchema = z
  .object({
    teamId: z.string().min(1),
  })
  .strict();

export const serviceAccountParamsSchema = z
  .object({
    serviceAccountId: z.string().min(1),
  })
  .strict();

export const deleteRequestSchema = z
  .object({
    deletedBy: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

// siteId 走 header 上下文，不进 body。slug 是 (siteId,slug) 幂等键。
export const upsertTeamRequestSchema = z
  .object({
    slug: z.string().trim().min(1),
    name: z.string().trim().min(1),
    ownerUserId: z.string().min(1),
  })
  .strict();

export const setMembershipRoleRequestSchema = z
  .object({
    teamId: z.string().min(1),
    userId: z.string().min(1),
    role: z.enum(["owner", "admin", "member"]),
  })
  .strict();

// GET /memberships/check 入参：hub self 面授权窄口，只收 teamId+userId（scope 语义由上游解析后传入）。
export const membershipCheckQuerySchema = z
  .object({
    teamId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
  })
  .strict();

// 对外响应契约：hub 经包入口 import 本 schema 消费，不手抄形状。role=null 表示非活跃成员。
export const membershipCheckResponseSchema = z.object({
  active: z.boolean(),
  role: z.enum(["owner", "admin", "member"]).nullable(),
});
export type MembershipCheckResponse = z.infer<typeof membershipCheckResponseSchema>;

// 终端用户会话签发（web → user，服务间调用）。snake_case 外部契约，site_id 走 body（非 header）。
export const issueSessionRequestSchema = z
  .object({
    site_id: z.string().trim().min(1),
    external_user_id: z.string().min(1),
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .strict();

// magic-link 申请（web → user）。email 归一化（trim+小写）后即身份键，限频与旧链作废都按它算。
export const requestMagicLinkRequestSchema = z
  .object({
    site_id: z.string().trim().min(1),
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

// magic-link 消费：token 即链接中的一次性原文（base64url），服务端只比对哈希。
export const consumeMagicLinkRequestSchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .strict();
