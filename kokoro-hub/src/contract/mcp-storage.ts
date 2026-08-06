import { z } from "zod";

// Hub's private Mongo shape is an owner-local persistence contract, not a Root wire mirror.
export const MCP_TRANSPORTS = ["http", "streamable_http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const mcpServerDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    transport: z.enum(MCP_TRANSPORTS),
    url: z.string().min(1),
    allowed_tools: z.array(z.string().min(1)),
    secret_ref: z.string().min(1).nullable(),
    enabled: z.boolean(),
    updated_at: z.number().int(),
    deleted_at: z.number().int().nullable(),
  })
  .strict();
export type McpServerDoc = z.infer<typeof mcpServerDocSchema>;

export const mcpServerRevisionDocSchema = z
  .object({
    scope: z.string().min(1),
    name: z.string().min(1),
    revision: z.number().int(),
    config_hash: z.string().min(1),
    transport: z.enum(MCP_TRANSPORTS),
    url: z.string().min(1),
    allowed_tools: z.array(z.string().min(1)),
    secret_ref: z.string().min(1).nullable(),
    created_at: z.number().int(),
  })
  .strict();
export type McpServerRevisionDoc = z.infer<typeof mcpServerRevisionDocSchema>;

export const MCP_SERVER_REVISIONS_COLLECTION = "mcp_server_revisions";
export const MCP_SERVERS_COLLECTION = "mcp_servers";
