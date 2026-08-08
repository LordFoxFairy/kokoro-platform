// GENERATED — DO NOT EDIT. Kokoro Root authority: contract/spec/control.yaml
// Root materialization (run from Kokoro Root): uv run --locked python contract/generate.py --output-root OUTPUT_ROOT
// Consumer regeneration (run from Kokoro Root): node contract/generate.mjs --consumer CONSUMER --source-root ROOT --output-repository CONSUMER_REPOSITORY

import { z } from "zod"

export const runInputSchema = z
  .object({
    message_id: z.string().min(1),
    content: z.string().min(1),
  })
  .strict()
export type RunInput = z.infer<typeof runInputSchema>

export const modelConfigSchema = z
  .object({
    provider: z.string().min(1),
    name: z.string().min(1),
    authorization_handle: z.string().min(1).max(256).refine((value) => value.trim() === value),
    effort: z.string().min(1).optional(),
    thinking: z.boolean().optional(),
  })
  .strict()
export type ModelConfig = z.infer<typeof modelConfigSchema>

export const skillGrantSchema = z
  .object({
    option_ref: z.string().min(1).max(256).refine((value) => value.trim() === value),
    name: z.string().min(1),
    content_hash: z.string().min(1),
    description: z.string().min(1),
    scope: z.string().min(1),
  })
  .strict()
export type SkillGrant = z.infer<typeof skillGrantSchema>

export const mcpGrantSchema = z
  .object({
    option_ref: z.string().min(1).max(256).refine((value) => value.trim() === value),
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    config_hash: z.string().min(1),
  })
  .strict()
export type McpGrant = z.infer<typeof mcpGrantSchema>

export const permissionsSchema = z
  .object({
    approval_tools: z.array(z.string().min(1)),
    review_tools: z.array(z.string().min(1)),
    subagent_create: z.enum(["deny", "ask", "allow"]),
    filesystem: z.enum(["read_only", "workspace_write"]),
  })
  .strict()
export type Permissions = z.infer<typeof permissionsSchema>

export const mediaRuntimeGrantSchema = z
  .object({
    media_access_handle: z.string().min(32).max(8192).refine((value) => value.trim() === value),
    media_projection_reservation_handle: z.string().min(32).max(8192).refine((value) => value.trim() === value),
  })
  .strict()
export type MediaRuntimeGrant = z.infer<typeof mediaRuntimeGrantSchema>

export const runtimeConfigSchema = z
  .object({
    agent_catalog_ref: z.string().min(1).max(256).refine((value) => value.trim() === value),
    agent_type: z.enum(["general"]),
    agent: z.string().min(1).optional(),
    model: modelConfigSchema,
    tools: z.array(z.string().min(1)),
    skills: z.array(skillGrantSchema),
    mcp_servers: z.array(mcpGrantSchema),
    subagents: z.array(z.string().min(1)),
    backend: z.enum(["state", "local_shell", "docker", "e2b", "custom"]),
    permissions: permissionsSchema,
    media: mediaRuntimeGrantSchema.optional(),
  })
  .strict()
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>

export const runtimeContextSchema = z
  .object({
    namespace: z.string().min(1),
    session_id: z.string().min(1),
  })
  .strict()
export type RuntimeContext = z.infer<typeof runtimeContextSchema>

const executionContextIntentRootSchema = z
  .object({
    mode: z.literal("root"),
  })
  .strict()

const executionContextIntentContinueSchema = z
  .object({
    parent_anchor: z.string().min(1).max(256).refine((value) => value.trim() === value),
    parent_digest: z.string().regex(/^[0-9a-f]{64}$/u),
    mode: z.literal("continue"),
  })
  .strict()

const executionContextIntentForkSchema = z
  .object({
    parent_anchor: z.string().min(1).max(256).refine((value) => value.trim() === value),
    parent_digest: z.string().regex(/^[0-9a-f]{64}$/u),
    mode: z.literal("fork"),
  })
  .strict()

export const executionContextIntentSchema = z.discriminatedUnion("mode", [
  executionContextIntentRootSchema,
  executionContextIntentContinueSchema,
  executionContextIntentForkSchema,
])
export type ExecutionContextIntent = z.infer<typeof executionContextIntentSchema>

export type Backend = RuntimeConfig["backend"]

const approveDecisionSchema = z.object({ type: z.literal("approve"), tool_id: z.string().min(1), args: z.record(z.string(), z.unknown()).optional() }).strict()
const editDecisionSchema = z.object({ type: z.literal("edit"), tool_id: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict()
const rejectDecisionSchema = z.object({ type: z.literal("reject"), tool_id: z.string().min(1), reason: z.string().optional() }).strict()
const respondDecisionSchema = z.object({ type: z.literal("respond"), tool_id: z.string().min(1), response: z.string().min(1) }).strict()
const submitDecisionSchema = z.object({ type: z.literal("submit"), request_id: z.string().min(1), value: z.record(z.string(), z.unknown()) }).strict()
export const resumeDecisionSchema = z.discriminatedUnion("type", [
  approveDecisionSchema,
  editDecisionSchema,
  rejectDecisionSchema,
  respondDecisionSchema,
  submitDecisionSchema,
])
export type ResumeDecision = z.infer<typeof resumeDecisionSchema>
export type ResumeDecisionType = ResumeDecision["type"]

export const runRequestSchema = z
  .object({
    kind: z.literal("run.request"),
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    input: runInputSchema,
    runtime: runtimeConfigSchema,
    context: runtimeContextSchema,
    execution_context: executionContextIntentSchema,
    trace: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
export type RunRequest = z.infer<typeof runRequestSchema>

export const runResumeSchema = z
  .object({
    kind: z.literal("run.resume"),
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    decision_id: z.string().min(1),
    decisions: z.array(resumeDecisionSchema).min(1),
  })
  .strict()
export type RunResume = z.infer<typeof runResumeSchema>

export const runCancelSchema = z
  .object({
    kind: z.literal("run.cancel"),
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    decision_id: z.string().min(1),
  })
  .strict()
export type RunCancel = z.infer<typeof runCancelSchema>

export const runSteerSchema = z
  .object({
    kind: z.literal("run.steer"),
    run_id: z.string().min(1),
    thread_id: z.string().min(1),
    message_id: z.string().min(1),
    content: z.string().min(1),
  })
  .strict()
export type RunSteer = z.infer<typeof runSteerSchema>

export const inboundMessageSchema = z.discriminatedUnion("kind", [
  runRequestSchema,
  runResumeSchema,
  runCancelSchema,
  runSteerSchema,
])
export type InboundMessage = z.infer<typeof inboundMessageSchema>
