import multipart from "@fastify/multipart";
import {
  declareRouteAccess,
  registerErrorHandler,
  registerOpenApi,
  registerRouteAccess,
  type RouteAccessConfig,
  type ServiceCaller,
} from "@kokoro/platform-kit";
import Fastify from "fastify";
import { McpHubService } from "../../application/mcp-hub-service.js";
import { McpSecretService } from "../../application/mcp-secret-service.js";
import { SkillHubService, type QuotaLimits } from "../../application/skill-hub-service.js";
import { SkillUploadService } from "../../application/skill-upload-service.js";
import type { McpSecretRepository } from "../../domain/mcp-secret-repository.js";
import type { McpServerRepository } from "../../domain/mcp-repository.js";
import type { SkillHubRepository } from "../../domain/repository.js";
import type { SecretCipher } from "../../domain/secret-cipher.js";
import { MAX_UPLOAD_ZIP_BYTES } from "../../domain/validation.js";
import type { PackageStore } from "../../infrastructure/packages/package-store.js";
import { denyAllMembershipAuthorizer, type MembershipAuthorizer } from "./membership-authorizer.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerHubRoutes } from "./routes.js";
import { registerSelfRoutes } from "./self-routes.js";
import { registerUploadRoutes } from "./upload-routes.js";

export interface CreateHubServerOptions {
  repository: SkillHubRepository;
  quotaLimits: QuotaLimits;
  // MCP server 注册表（HUB-3）；缺省 = 不挂 MCP 路由（skills-only 测试可省略，main 恒注入）。
  mcpRepository?: McpServerRepository | null;
  // MCP secret 仓储 + 信封 cipher（MCP-SECRET 半场）；两者齐备才启用 secret broker，
  // 缺任一 = secret 面 503 fail-loud（绝不无密钥明文落库）。
  secretRepository?: McpSecretRepository | null;
  secretCipher?: SecretCipher | null;
  // 包体存储（内容寻址 zip，ADR-009 hub 节）；缺省 null = 上传 confirm 面 503 fail-loud。
  packageStore?: PackageStore | null;
  // 关闭 Mongo 连接等外部资源；由 main 注入（测试自管连接则省略）。
  onClose?: () => Promise<void>;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
  // self 面成员校验器；缺省 fail-closed。生产只接受 PostgreSQL Platform owner adapter。
  membershipAuthorizer?: MembershipAuthorizer;
  // self 面 MCP mutation 部署门（KOKORO_HUB_MCP_MUTATION=on）；缺省 false = mutation 恒 503 fail-closed。
  mcpMutationEnabled?: boolean;
  // self 面 URL 预校验解析器注入（测试用）；缺省用真 DNS。
  mcpUrlResolver?: (hostname: string) => Promise<string[]>;
  // admin/official MCP 注册 env:VAR 准入白名单；缺省空集，所有 env 引用 fail-closed。
  mcpEnvRefAllowlist?: ReadonlySet<string>;
  // 仅本地/test 显式启用 HTTP scheme；地址仍必须是公网单播，生产装配永不传 true。
  allowInsecureMcpUrl?: boolean;
}

// HTTP 仅承载用户 self-service 与 admin 管理面；Agent 运行时装配只走 mTLS ConnectRPC。
const HUB_REQUIRED_CALLERS: ServiceCaller[] = ["web-bff", "admin"];

export function createHubServer(options: CreateHubServerOptions) {
  const app = Fastify({ logger: false });

  registerOpenApi(app, { title: "Kokoro Hub API", version: "0.1.0" });
  registerErrorHandler(app, (error, request) => {
    request.log.error({ error }, "unexpected hub http error");
  });

  // 服务间被调面：default-internal。HTTP 只保留 /hub/self 与 /hub/admin；
  // Agent 运行时装配由独立 mTLS ConnectRPC 服务提供。/healthz 公开。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: HUB_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, { path: "/metrics", exact: true }, "public");
  declareRouteAccess(app, "/hub/self", "web-bff");
  declareRouteAccess(app, "/hub/admin", "admin");
  declareRouteAccess(app, { path: "/docs/json", exact: true }, "admin");
  // multipart 档上传（zip 单文件）；JSON base64 档限制在上传路由 bodyLimit。
  void app.register(multipart, { limits: { files: 1, fileSize: MAX_UPLOAD_ZIP_BYTES } });

  const service = new SkillHubService(options.repository, options.quotaLimits);
  const uploadService = new SkillUploadService(
    options.repository,
    options.packageStore ?? null,
    options.quotaLimits,
  );

  const mcpService =
    options.mcpRepository === undefined || options.mcpRepository === null
      ? null
      : new McpHubService(options.mcpRepository);

  // secret broker：仓储 + cipher 齐备才启用；缺任一 = null → secret 面 503 fail-loud。
  const secretRepository = options.secretRepository ?? null;
  const secretCipher = options.secretCipher ?? null;
  const secretService =
    secretRepository !== null && secretCipher !== null
      ? new McpSecretService(secretRepository, secretCipher)
      : null;

  const authorizer = options.membershipAuthorizer ?? denyAllMembershipAuthorizer;

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    // self 面（web-bff）：信封 scope + 成员校验；MCP 只读，mutation 恒 503；secret broker CRUD。
    registerSelfRoutes(instance, {
      skillService: service,
      uploadService,
      mcpService,
      secretService,
      authorizer,
      mcpMutationEnabled: options.mcpMutationEnabled ?? false,
      ...(options.mcpUrlResolver !== undefined ? { mcpUrlResolver: options.mcpUrlResolver } : {}),
    });
    // admin 面（网关）：健康检查/manifest/审核/运营/官方位/软删/上传/MCP 管理（现管理面全量迁 /hub/admin）。
    registerHubRoutes(instance, service);
    registerUploadRoutes(instance, uploadService);
    if (mcpService !== null) {
      registerMcpRoutes(instance, mcpService, {
        envRefAllowlist: options.mcpEnvRefAllowlist ?? new Set(),
        allowInsecureUrl: options.allowInsecureMcpUrl ?? false,
        ...(options.mcpUrlResolver === undefined ? {} : { urlResolver: options.mcpUrlResolver }),
      });
    }
  });

  if (options.onClose) {
    const onClose = options.onClose;
    app.addHook("onClose", async () => {
      await onClose();
    });
  }

  return app;
}
