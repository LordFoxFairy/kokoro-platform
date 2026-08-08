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
    display_weight: z.number().int().optional(),
    pinned: z.boolean().optional(),
    category: z.string().min(1).nullable().optional(),
    review_status: z.enum(["pending", "approved", "rejected"]).optional(),
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

export const skillRevisionDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    content_hash: z.string().min(1),
    package_size: z.number().int(),
    source: z.enum(["deploy", "upload", "github"]),
    created_at: z.number().int(),
  })
  .strict()
export type SkillRevisionDoc = z.infer<typeof skillRevisionDocSchema>

export const mcpServerDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    transport: z.enum(["http", "streamable_http"]),
    url: z.string().min(1),
    allowed_tools: z.array(z.string().min(1)),
    secret_ref: z.string().min(1).nullable(),
    enabled: z.boolean(),
    updated_at: z.number().int(),
    deleted_at: z.number().int().nullable(),
  })
  .strict()
export type McpServerDoc = z.infer<typeof mcpServerDocSchema>

export const mcpServerRevisionDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    config_hash: z.string().min(1),
    transport: z.enum(["http", "streamable_http"]),
    url: z.string().min(1),
    allowed_tools: z.array(z.string().min(1)),
    secret_ref: z.string().min(1).nullable(),
    created_at: z.number().int(),
  })
  .strict()
export type McpServerRevisionDoc = z.infer<typeof mcpServerRevisionDocSchema>

export const runDispatchDocSchema = z
  .object({
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    namespace: z.string().min(1),
    fence: z.string().min(1),
    status: z.enum(["pending", "claimed", "expired"]),
    deadline_at: z.number().int(),
    claimed_by: z.string().min(1).nullable().optional(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict()
export type RunDispatchDoc = z.infer<typeof runDispatchDocSchema>

export const mcpSecretDocSchema = z
  .object({
    scope: z.string().min(1),
    handle: z.string().min(1),
    name: z.string().min(1),
    ciphertext: z.string().min(1),
    key_id: z.string().min(1),
    created_at: z.number().int(),
    deleted_at: z.number().int().nullable(),
  })
  .strict()
export type McpSecretDoc = z.infer<typeof mcpSecretDocSchema>

export const runEventReceiptDocSchema = z
  .object({
    run_id: z.string().min(1),
    durable_seq: z.number().int(),
    event_id: z.string().min(1),
    status: z.enum(["persisted", "rejected", "superseded"]),
    reason: z.string().min(1).nullable().optional(),
    created_at: z.number().int(),
  })
  .strict()
export type RunEventReceiptDoc = z.infer<typeof runEventReceiptDocSchema>

export const runReceiptManifestDocSchema = z
  .object({
    run_id: z.string().min(1),
    persisted_seq: z.number().int(),
    projected_seq: z.number().int(),
    consumed_seq: z.number().int(),
    terminal_fence_seq: z.number().int().nullable().optional(),
    superseded_from: z.number().int().nullable().optional(),
    producer_close_requested: z.boolean(),
    producer_closed: z.boolean(),
    updated_at: z.number().int(),
  })
  .strict()
export type RunReceiptManifestDoc = z.infer<typeof runReceiptManifestDocSchema>

export const MCP_SECRETS_COLLECTION = "mcp_secrets"
export const MCP_SERVER_REVISIONS_COLLECTION = "mcp_server_revisions"
export const MCP_SERVERS_COLLECTION = "mcp_servers"
export const RUN_DISPATCHES_COLLECTION = "run_dispatches"
export const RUN_EVENT_RECEIPTS_COLLECTION = "run_event_receipts"
export const RUN_RECEIPT_MANIFESTS_COLLECTION = "run_receipt_manifests"
export const SKILL_REVISIONS_COLLECTION = "skill_revisions"
export const SKILL_STATE_COLLECTION = "skill_state"
export const SKILLS_COLLECTION = "skills"

export const WORKSPACE_KEY_TEMPLATE = "{namespace}:{session_id}"

// 会话工作区键（本地目录名 / S3 归档前缀）：单源模板，双语言同构，禁手拼。
export function workspaceKey(namespace: string, sessionId: string): string {
  return `${namespace}:${sessionId}`
}
