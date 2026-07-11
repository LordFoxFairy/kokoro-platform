import { startHttpServer } from "@kokoro/platform-kit";
import { loadHubEnv } from "../../config/env.js";
import { loadHubStoreLocation } from "../../config/storage.js";
import { createMongoClient, hubCollections } from "../../infrastructure/mongo/mongo-client.js";
import { MongoSkillRepository } from "../../infrastructure/mongo/mongo-skill-repository.js";
import { makePackageStore } from "../../infrastructure/packages/package-store.js";
import { createHubServer } from "./server.js";

const env = loadHubEnv();
const client = createMongoClient(env.KOKORO_HUB_MONGO_URL);
await client.connect();
const repository = new MongoSkillRepository(hubCollections(client.db(env.KOKORO_HUB_MONGO_DB)));

// 包体存储：ADR-009 yaml hub 节（与 agent 装配读路同源）；未配置 = 上传写面 503，其余面照常。
const hubStoreLocation = loadHubStoreLocation(env.KOKORO_WORKSPACE_CONFIG);
const packageStore =
  hubStoreLocation === null
    ? null
    : makePackageStore(
        hubStoreLocation,
        env.KOKORO_WORKSPACE_S3_ACCESS_KEY !== undefined &&
          env.KOKORO_WORKSPACE_S3_SECRET_KEY !== undefined
          ? {
              accessKeyId: env.KOKORO_WORKSPACE_S3_ACCESS_KEY,
              secretAccessKey: env.KOKORO_WORKSPACE_S3_SECRET_KEY,
            }
          : null,
      );

await startHttpServer({
  moduleName: "kokoro-hub",
  port: env.KOKORO_HUB_PORT,
  createServer: () =>
    createHubServer({
      repository,
      packageStore,
      quotaLimits: {
        maxPackages: env.KOKORO_HUB_QUOTA_MAX_PACKAGES,
        maxBytes: env.KOKORO_HUB_QUOTA_MAX_BYTES,
      },
      onClose: () => client.close(),
    }),
});
