import multipart from "@fastify/multipart";
import { registerErrorHandler, registerOpenApi } from "@kokoro/platform-kit";
import Fastify from "fastify";
import { SkillHubService, type QuotaLimits } from "../../application/skill-hub-service.js";
import { SkillUploadService } from "../../application/skill-upload-service.js";
import type { SkillHubRepository } from "../../domain/repository.js";
import { MAX_UPLOAD_ZIP_BYTES } from "../../domain/validation.js";
import type { PackageStore } from "../../infrastructure/packages/package-store.js";
import { registerHubRoutes } from "./routes.js";
import { registerUploadRoutes } from "./upload-routes.js";

export interface CreateHubServerOptions {
  repository: SkillHubRepository;
  quotaLimits: QuotaLimits;
  // 包体存储（内容寻址 zip，ADR-009 hub 节）；缺省 null = 上传 confirm 面 503 fail-loud。
  packageStore?: PackageStore | null;
  // 关闭 Mongo 连接等外部资源；由 main 注入（测试自管连接则省略）。
  onClose?: () => Promise<void>;
}

export function createHubServer(options: CreateHubServerOptions) {
  const app = Fastify({ logger: false });

  registerOpenApi(app, { title: "Kokoro Hub API", version: "0.1.0" });
  registerErrorHandler(app, (error, request) => {
    request.log.error({ error }, "unexpected hub http error");
  });
  // multipart 档上传（zip 单文件）；JSON base64 档限制在上传路由 bodyLimit。
  void app.register(multipart, { limits: { files: 1, fileSize: MAX_UPLOAD_ZIP_BYTES } });

  const service = new SkillHubService(options.repository, options.quotaLimits);
  const uploadService = new SkillUploadService(
    options.repository,
    options.packageStore ?? null,
    options.quotaLimits,
  );

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    registerHubRoutes(instance, service);
    registerUploadRoutes(instance, uploadService);
  });

  if (options.onClose) {
    const onClose = options.onClose;
    app.addHook("onClose", async () => {
      await onClose();
    });
  }

  return app;
}
