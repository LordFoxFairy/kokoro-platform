import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Generation is intentionally offline. The checked migrator is the only
    // production migration entrypoint and requires the real URL before CLI execution.
    url:
      process.env.DATABASE_URL_PLATFORM ?? "postgresql://offline-generate.invalid/kokoro_platform",
  },
});
