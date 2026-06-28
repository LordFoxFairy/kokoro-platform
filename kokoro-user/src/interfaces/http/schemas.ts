import { z } from "zod";

export const ensureUserRequestSchema = z
  .object({
    externalUserId: z.string().min(1),
    email: z.string().email().optional(),
    displayName: z.string().min(1).optional(),
    avatarUrl: z.string().url().optional(),
  })
  .strict();
