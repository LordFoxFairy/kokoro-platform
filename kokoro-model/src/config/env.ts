import { z } from "zod";

export const modelEnvSchema = z.object({
  DATABASE_URL_MODEL: z.string().url(),
  KOKORO_MODEL_PORT: z.coerce.number().int().min(1).max(65535).default(4221),
});

export type ModelEnv = z.infer<typeof modelEnvSchema>;

export function loadModelEnv(env: NodeJS.ProcessEnv = process.env): ModelEnv {
  return modelEnvSchema.parse(env);
}
