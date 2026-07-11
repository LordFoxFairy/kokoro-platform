import { registerErrorHandler, registerOpenApi } from "@kokoro/platform-kit";
import Fastify from "fastify";
import { SkillHubService, type QuotaLimits } from "../../application/skill-hub-service.js";
import type { SkillHubRepository } from "../../domain/repository.js";
import { registerHubRoutes } from "./routes.js";

export interface CreateHubServerOptions {
  repository: SkillHubRepository;
  quotaLimits: QuotaLimits;
  // 关闭 Mongo 连接等外部资源；由 main 注入（测试自管连接则省略）。
  onClose?: () => Promise<void>;
}

export function createHubServer(options: CreateHubServerOptions) {
  const app = Fastify({ logger: false });

  registerOpenApi(app, { title: "Kokoro Hub API", version: "0.1.0" });
  registerErrorHandler(app, (error, request) => {
    request.log.error({ error }, "unexpected hub http error");
  });

  const service = new SkillHubService(options.repository, options.quotaLimits);

  // WHY: 路由须包进 register 闭包，确保在异步入队的 swagger 插件之后加载，否则 onRoute 钩子漏采。
  void app.register(async (instance) => {
    registerHubRoutes(instance, service);
  });

  if (options.onClose) {
    const onClose = options.onClose;
    app.addHook("onClose", async () => {
      await onClose();
    });
  }

  return app;
}
