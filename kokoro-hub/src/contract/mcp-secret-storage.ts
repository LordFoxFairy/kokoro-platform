import { z } from "zod";

// Secret ciphertext is Hub-private persistence; only the opaque handle crosses HTTP boundaries.
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
  .strict();
export type McpSecretDoc = z.infer<typeof mcpSecretDocSchema>;

export const MCP_SECRETS_COLLECTION = "mcp_secrets";

// srt_ + 128-bit random hexadecimal value.
export const SECRET_HANDLE_RE = /^srt_[0-9a-f]{32}$/;
