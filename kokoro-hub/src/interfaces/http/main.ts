import { isProductionEnv, loadCallerSecrets, startHttpServer } from "@kokoro/platform-kit";
import { loadHubEnv } from "../../config/env.js";
import { loadSecretKeyring } from "../../config/secret-keyring.js";
import { loadHubStoreLocation } from "../../config/storage.js";
import { AesGcmSecretCipher } from "../../infrastructure/crypto/aes-gcm-secret-cipher.js";
import { createMongoClient, hubCollections } from "../../infrastructure/mongo/mongo-client.js";
import { MongoMcpSecretRepository } from "../../infrastructure/mongo/mongo-mcp-secret-repository.js";
import { MongoMcpServerRepository } from "../../infrastructure/mongo/mongo-mcp-server-repository.js";
import { MongoSkillRepository } from "../../infrastructure/mongo/mongo-skill-repository.js";
import { makePackageStore } from "../../infrastructure/packages/package-store.js";
import { HttpMembershipAuthorizer } from "./membership-authorizer.js";
import { parseEnvRefAllowlist } from "./mcp-server-ref.js";
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

// MCP secret broker：主密钥经 env 密钥环（生产强制配置，缺失 fail-fast，杜绝无密钥空跑）。
// 非生产缺主密钥 = secret 面 503（其余面照常），本地可无 secret 起服。
const secretKeyring = loadSecretKeyring(env);
if (secretKeyring === null && isProductionEnv()) {
  throw new Error("生产环境缺少 KOKORO_HUB_SECRET_MASTER_KEY：MCP secret broker 无法安全启用");
}
const secretCipher = secretKeyring === null ? null : new AesGcmSecretCipher(secretKeyring);
const secretRepository = secretCipher === null ? null : new MongoMcpSecretRepository(collections);

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
      secretRepository,
      secretCipher,
      packageStore,
      quotaLimits: {
        maxPackages: env.KOKORO_HUB_QUOTA_MAX_PACKAGES,
        maxBytes: env.KOKORO_HUB_QUOTA_MAX_BYTES,
      },
      routeAccess: { secrets: callerSecrets, isProduction: isProductionEnv() },
      membershipAuthorizer,
      // self 面 MCP mutation 部署门：KOKORO_HUB_MCP_MUTATION=on 才开（HUB-CONSIST 跨仓 E2E 过后）。
      mcpMutationEnabled: env.KOKORO_HUB_MCP_MUTATION === "on",
      mcpEnvRefAllowlist: parseEnvRefAllowlist(env.KOKORO_HUB_ENV_REF_ALLOWLIST),
      // 本地显式逃生口；生产即使误配也保持 SSRF 防线关闭逃生口。
      allowInsecureMcpUrl: !isProductionEnv() && env.KOKORO_HUB_ALLOW_INSECURE_URL === "1",
      onClose: () => client.close(),
    }),
});
