import { creditPlatformModule } from "@kokoro/credit";
import { hubPlatformModule } from "@kokoro/hub";
import { paymentPlatformModule } from "@kokoro/payment";
import { sitePlatformModule } from "@kokoro/site";
import { userPlatformModule } from "@kokoro/user";
import type { PlatformModuleDescriptor } from "./platform-module.js";
import { modelControlPlatformModule } from "./modules/model-control/index.js";

const litellmPlatformModule = {
  id: "litellm",
  labelKey: "platform.modules.litellm",
  directory: "kokoro-litellm",
  status: "external",
  kind: "gateway",
  envFile: "kokoro-litellm/.env.example",
  storage: {
    primary: "external",
    ownsMigrations: false,
  },
  admin: {
    mode: "external",
    basePath: "/admin/litellm",
  },
  runtime: {
    surfaces: ["external-service"],
    notes: [
      "LiteLLM 是大模型网关，不是平台业务权威。",
      "平台只负责账号、权限、模型可见性和 provider 配置治理。",
    ],
  },
  dependencies: ["model"],
  boundaries: {
    owns: ["LLM gateway runtime", "provider request proxy"],
    doesNotOwn: ["model catalog authority", "credit ledger", "user identity"],
  },
} satisfies PlatformModuleDescriptor;

export const platformModules = [
  sitePlatformModule,
  userPlatformModule,
  modelControlPlatformModule,
  creditPlatformModule,
  paymentPlatformModule,
  hubPlatformModule,
  litellmPlatformModule,
] satisfies readonly PlatformModuleDescriptor[];

export function listPlatformModules(): readonly PlatformModuleDescriptor[] {
  return platformModules;
}

export function getPlatformModule(id: string): PlatformModuleDescriptor | undefined {
  return platformModules.find((module) => module.id === id);
}

export function listActivePlatformModules(): PlatformModuleDescriptor[] {
  return platformModules.filter((module) => module.status === "active");
}

export function assertPlatformRegistryIntegrity(
  modules: readonly PlatformModuleDescriptor[] = platformModules,
): void {
  const ids = new Set<string>();
  const directories = new Set<string>();

  for (const module of modules) {
    assertUnique(ids, module.id, "module id");
    assertUnique(directories, module.directory, "module directory");

    if (module.storage.primary === "mysql" && !module.storage.databaseEnv) {
      throw new Error(`module ${module.id} uses MySQL but does not declare databaseEnv`);
    }

    if (module.status !== "external" && !module.packageName) {
      throw new Error(`module ${module.id} must declare packageName`);
    }

    if (module.admin.mode === "manifest" && !module.admin.manifestExport) {
      throw new Error(`module ${module.id} admin manifest must declare manifestExport`);
    }

    if (
      module.status === "active" &&
      !module.service &&
      !module.runtime.surfaces.includes("local-application")
    ) {
      throw new Error(`active module ${module.id} must declare service discovery metadata`);
    }
  }
}

function assertUnique(seen: Set<string>, value: string, label: string): void {
  if (seen.has(value)) {
    throw new Error(`duplicate ${label}: ${value}`);
  }

  seen.add(value);
}
