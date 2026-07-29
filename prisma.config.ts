import { defineConfig } from "prisma/config";
import { resolve } from "node:path";

export default defineConfig({
  schema: resolve(process.cwd(), "prisma/schema.prisma"),
  migrations: {
    path: resolve(process.cwd(), "prisma/migrations"),
  },
  datasource: {
    // Generation is intentionally offline. The checked migrator is the only
    // production migration entrypoint and requires the real URL before CLI execution.
    url:
      process.env.DATABASE_URL_PLATFORM ?? "postgresql://offline-generate.invalid/kokoro_platform",
  },
});
