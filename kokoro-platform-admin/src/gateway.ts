import { adminModuleManifestSchema, type AdminModuleManifest } from "@kokoro/platform-kit";
import { z } from "zod";
import type { ModuleConfig } from "./config.js";

// sendData 包装：所有模块端点响应都是 { data: <payload> }
const manifestEnvelopeSchema = z.object({ data: adminModuleManifestSchema });
const resourceEnvelopeSchema = z.object({ data: z.array(z.record(z.unknown())) });

export interface ModuleOnline {
  id: string;
  label: string;
  baseUrl: string;
  online: true;
  manifest: AdminModuleManifest;
}

export interface ModuleOffline {
  id: string;
  label: string;
  baseUrl: string;
  online: false;
  error: string;
}

export type ModuleStatus = ModuleOnline | ModuleOffline;

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

async function fetchManifest(module: ModuleConfig): Promise<ModuleStatus> {
  try {
    const response = await fetch(joinUrl(module.baseUrl, module.manifestPath));
    if (!response.ok) {
      return { id: module.id, label: module.label, baseUrl: module.baseUrl, online: false, error: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    const manifest = manifestEnvelopeSchema.parse(body).data;
    return { id: module.id, label: module.label, baseUrl: module.baseUrl, online: true, manifest };
  } catch (error) {
    return {
      id: module.id,
      label: module.label,
      baseUrl: module.baseUrl,
      online: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getManifests(modules: ModuleConfig[]): Promise<ModuleStatus[]> {
  return Promise.all(modules.map(fetchManifest));
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// 校验 moduleId 已知 + route ∈ manifest.resources[].route，防开放代理/SSRF
export async function proxyResource(
  modules: ModuleConfig[],
  moduleId: string,
  route: string,
): Promise<unknown[]> {
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${moduleId}`, 400);
  }

  const status = await fetchManifest(module);
  if (!status.online) {
    throw new GatewayError(`module offline: ${status.error}`, 502);
  }

  const allowed = status.manifest.resources.some((resource) => resource.route === route);
  if (!allowed) {
    throw new GatewayError(`route not allowed for module ${moduleId}: ${route}`, 403);
  }

  const response = await fetch(joinUrl(module.baseUrl, route));
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }

  const body: unknown = await response.json();
  return resourceEnvelopeSchema.parse(body).data;
}
