import { startHttpServer } from "@kokoro/platform-kit";
import { loadHubEnv } from "../../config/env.js";
import { createMongoClient, hubCollections } from "../../infrastructure/mongo/mongo-client.js";
import { MongoSkillRepository } from "../../infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "./server.js";

const env = loadHubEnv();
const client = createMongoClient(env.KOKORO_HUB_MONGO_URL);
await client.connect();
const repository = new MongoSkillRepository(hubCollections(client.db(env.KOKORO_HUB_MONGO_DB)));

await startHttpServer({
  moduleName: "kokoro-hub",
  port: env.KOKORO_HUB_PORT,
  createServer: () =>
    createHubServer({
      repository,
      quotaLimits: {
        maxPackages: env.KOKORO_HUB_QUOTA_MAX_PACKAGES,
        maxBytes: env.KOKORO_HUB_QUOTA_MAX_BYTES,
      },
      onClose: () => client.close(),
    }),
});
