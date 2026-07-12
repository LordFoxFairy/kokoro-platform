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
import { SkillHubService, type QuotaLimits } from "../../application/skill-hub-service.js";
import { SkillUploadService } from "../../application/skill-upload-service.js";
import type { McpServerRepository } from "../../domain/mcp-repository.js";
import type { SkillHubRepository } from "../../domain/repository.js";
import { MAX_UPLOAD_ZIP_BYTES } from "../../domain/validation.js";
import type { PackageStore } from "../../infrastructure/packages/package-store.js";
import { denyAllMembershipAuthorizer, type MembershipAuthorizer } from "./membership-authorizer.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerHubRoutes } from "./routes.js";
import { registerRuntimeRoutes } from "./runtime-routes.js";
import { registerSelfRoutes } from "./self-routes.js";
import { registerUploadRoutes } from "./upload-routes.js";

export interface CreateHubServerOptions {
  repository: SkillHubRepository;
  quotaLimits: QuotaLimits;
  // MCP server 注册表（HUB-3）；缺省 = 不挂 MCP 路由（skills-only 测试可省略，main 恒注入）。
  mcpRepository?: McpServerRepository | null;
  // 包体存储（内容寻址 zip，ADR-009 hub 节）；缺省 null = 上传 confirm 面 503 fail-loud。
  packageStore?: PackageStore | null;
  // 关闭 Mongo 连接等外部资源；由 main 注入（测试自管连接则省略）。
  onClose?: () => Promise<void>;
  // 入站访问控制配置；不传=空 secret + 非生产=dev 直通（测试/本地）；生产由 main.ts 注入 per-caller secret。
  routeAccess?: RouteAccessConfig;
  // self 面成员校验器；缺省 fail-closed(一切 self 请求 403)。main 注入 HTTP 版(调 user /memberships/check)，测试注入 fake。
  membershipAuthorizer?: MembershipAuthorizer;
}

// hub 所需 caller 凭据（HUB-AUTHZ 三面）：
// 入站——session(runtime pool/resolve)、web-bff(self self-service)、admin(网关 admin 面)；
// 出站——hub 自身(caller=hub 调 user /memberships/check 做 self 成员校验)。
const HUB_REQUIRED_CALLERS: ServiceCaller[] = ["session", "web-bff", "admin", "hub"];

export function createHubServer(options: CreateHubServerOptions) {
  const app = Fastify({ logger: false });

  registerOpenApi(app, { title: "Kokoro Hub API", version: "0.1.0" });
  registerErrorHandler(app, (error, request) => {
    request.log.error({ error }, "unexpected hub http error");
  });

  // 服务间被调面：default-internal。HUB-AUTHZ 三前缀分级——
  // /hub/runtime(runtime caller: session/agent 读池/resolve)、/hub/self(仅 web-bff: 信封 self-service)、
  // /hub/admin(仅 admin 网关: 审核/运营/官方位/软删/MCP 管理)。/healthz 公开。
  const ra = options.routeAccess ?? { secrets: {}, isProduction: false };
  registerRouteAccess(app, { ...ra, requiredCallers: HUB_REQUIRED_CALLERS });
  declareRouteAccess(app, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(app, "/hub/runtime", "runtime-internal");
  declareRouteAccess(app, "/hub/self", "web-bff");
  declareRouteAccess(app, "/hub/admin", "admin");
  declareRouteAccess(app, "/docs", "runtime-internal");
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

  const authorizer = options.membershipAuthorizer ?? denyAllMembershipAuthorizer;

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    // runtime 面（session/agent）：按已验 namespace 读池 + 聚合 resolve。
    registerRuntimeRoutes(instance, service, mcpService);
    // self 面（web-bff）：信封 scope + 成员校验；MCP 只读，mutation 恒 503。
    registerSelfRoutes(instance, { skillService: service, uploadService, mcpService, authorizer });
    // admin 面（网关）：健康检查/manifest/审核/运营/官方位/软删/上传/MCP 管理（现管理面全量迁 /hub/admin）。
    registerHubRoutes(instance, service);
    registerUploadRoutes(instance, uploadService);
    if (mcpService !== null) {
      registerMcpRoutes(instance, mcpService);
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
