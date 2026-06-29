import type { FastifyInstance } from "fastify";
import { sendData } from "../http/responses.js";
import type { AdminModuleManifest } from "./manifest-schema.js";

// 暴露模块 admin manifest 供后台壳子发现资源/动作/权限。
export function registerAdminManifestRoute(app: FastifyInstance, manifest: AdminModuleManifest): void {
  app.get(`${manifest.basePath}/manifest`, async (_request, reply) => sendData(reply, manifest));
}
