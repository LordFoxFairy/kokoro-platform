// GENERATED — DO NOT EDIT. Source: contract/spec/storage.yaml
// Regenerate: python3 contract/generate.py

import { z } from "zod"

export const skillCardSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    content_hash: z.string().min(1),
  })
  .strict()
export type SkillCard = z.infer<typeof skillCardSchema>

export const skillFileEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int(),
  })
  .strict()
export type SkillFileEntry = z.infer<typeof skillFileEntrySchema>

export const skillDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    skill_md: z.string().min(1),
    files_manifest: z.array(skillFileEntrySchema),
    file_count: z.number().int(),
    package_size: z.number().int(),
    content_hash: z.string().min(1),
    package_ref: z.string().min(1),
    source: z.enum(["deploy", "upload", "github"]),
    revision: z.number().int(),
    official_enabled: z.boolean(),
    official_required: z.boolean(),
    updated_at: z.number().int(),
    deleted_at: z.number().int().optional(),
  })
  .strict()
export type SkillDoc = z.infer<typeof skillDocSchema>

export const skillStateDocSchema = z
  .object({
    namespace: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    updated_at: z.number().int(),
  })
  .strict()
export type SkillStateDoc = z.infer<typeof skillStateDocSchema>

export const SKILL_STATE_COLLECTION = "skill_state"
export const SKILLS_COLLECTION = "skills"

export const WORKSPACE_KEY_TEMPLATE = "{namespace}:{session_id}"

// 会话工作区键（本地目录名 / S3 归档前缀）：单源模板，双语言同构，禁手拼。
export function workspaceKey(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}`
}
