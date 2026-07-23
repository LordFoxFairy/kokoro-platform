import type { FastifyInstance } from "fastify";
import { collectDefaultMetrics, register } from "prom-client";

// 平台服务统一 /metrics 面：默认进程/Node 指标（内存/GC/事件循环/句柄），带 module 标签。
// 每服务=独立进程，故用 prom-client 全局默认注册表即可（一进程一模块，标签不冲突）。
// collectDefaultMetrics 进程内只装一次（started 门），避免测试同进程多次实例化时重复注册默认采集器。
// 采集恒 fail-open——/metrics 渲染异常绝不拖垮服务（指标是旁路，非主链路）。
let defaultsStarted = false;

export function registerMetricsRoute(app: FastifyInstance, moduleName: string): void {
  if (!defaultsStarted) {
    defaultsStarted = true;
    register.setDefaultLabels({ module: moduleName });
    collectDefaultMetrics();
  }
  app.get("/metrics", async (_request, reply) => {
    try {
      const body = await register.metrics();
      return reply.code(200).header("content-type", register.contentType).send(body);
    } catch {
      // 指标故障不得影响服务健康：fail-open 返回空体。
      return reply.code(200).header("content-type", "text/plain; version=0.0.4").send("");
    }
  });
}
