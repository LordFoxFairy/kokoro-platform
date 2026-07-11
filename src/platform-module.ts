export type PlatformModuleStatus = "active" | "planned" | "external";

export type PlatformModuleKind =
  | "site"
  | "identity"
  | "model-registry"
  | "credit"
  | "payment"
  | "gateway"
  | "capability-hub";

export type PlatformStorageKind = "mysql" | "mongo" | "external" | "none";

export type PlatformRuntimeSurface =
  | "http"
  | "internal-api"
  | "admin-manifest"
  | "external-service";

export interface PlatformModuleStorage {
  primary: PlatformStorageKind;
  databaseEnv?: string;
  ownsMigrations: boolean;
}

export interface PlatformModuleAdmin {
  mode: "manifest" | "external" | "planned" | "none";
  basePath?: string;
  manifestExport?: string;
}

export interface PlatformModuleRuntime {
  surfaces: readonly PlatformRuntimeSurface[];
  routes?: readonly string[];
  notes: readonly string[];
}

export interface PlatformModuleService {
  serviceName: string;
  portEnv: string;
  defaultPort: number;
  baseUrlEnv: string;
}

export interface PlatformModuleBoundaries {
  owns: readonly string[];
  doesNotOwn: readonly string[];
}

export interface PlatformModuleDescriptor {
  id: string;
  labelKey: string;
  packageName?: string;
  directory: string;
  status: PlatformModuleStatus;
  kind: PlatformModuleKind;
  envFile?: string;
  storage: PlatformModuleStorage;
  admin: PlatformModuleAdmin;
  runtime: PlatformModuleRuntime;
  service?: PlatformModuleService;
  dependencies: readonly string[];
  boundaries: PlatformModuleBoundaries;
}
