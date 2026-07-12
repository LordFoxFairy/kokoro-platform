import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadHubEnv } from "../../config/env.js";
import { loadHubStoreLocation } from "../../config/storage.js";
import { createMongoClient, hubCollections } from "../../infrastructure/mongo/mongo-client.js";
import { MongoMcpServerRepository } from "../../infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../infrastructure/mongo/mongo-skill-repository.js";
import { makePackageStore } from "../../infrastructure/packages/package-store.js";
import { HttpMembershipAuthorizer } from "./membership-authorizer.js";
import { createHubServer } from "./server.js";

const env = loadHubEnv();
const callerSecrets = loadCallerSecrets();
// self 面成员校验：caller=hub 出站，凭据取 hub 自身 per-caller secret；user route-access 校验 hub 属 runtime-internal。
const membershipAuthorizer = new HttpMembershipAuthorizer({
  userBaseUrl: env.KOKORO_USER_BASE_URL,
  ...(callerSecrets.hub !== undefined ? { internalSecret: callerSecrets.hub } : {}),
});
const client = createMongoClient(env.KOKORO_HUB_MONGO_URL);
await client.connect();
const collections = hubCollections(client.db(env.KOKORO_HUB_MONGO_DB));
const repository = new MongoSkillRepository(collections);
const mcpRepository = new MongoMcpServerRepository(collections);

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
      mcpRepository,
      packageStore,
      quotaLimits: {
        maxPackages: env.KOKORO_HUB_QUOTA_MAX_PACKAGES,
        maxBytes: env.KOKORO_HUB_QUOTA_MAX_BYTES,
      },
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
      membershipAuthorizer,
      onClose: () => client.close(),
    }),
});
