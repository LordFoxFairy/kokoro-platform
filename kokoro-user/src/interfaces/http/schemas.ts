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

// 终端用户会话签发（web → user，服务间调用）。snake_case 外部契约，site_id 走 body（非 header）。
export const issueSessionRequestSchema = z
  .object({
    site_id: z.string().trim().min(1),
    external_user_id: z.string().min(1),
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .strict();
