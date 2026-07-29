import type { PlatformModuleDescriptor } from "../../platform-module.js";

export { ImportModelControlService } from "./application/services/import-model-control.js";
export { ActivateModelInventoryService } from "./application/services/activate-model-inventory.js";
export { ChangeSiteModelPolicyService } from "./application/services/change-site-model-policy.js";
export { ResolveModelPolicyService } from "./application/services/resolve-model-policy.js";
export type {
  ModelControlApplication,
  ModelInventoryActivationAdministration,
  ModelInventoryImportAdministration,
  SiteModelPolicyAdministration,
  ResolveModelPolicyInput,
  ResolveModelPolicyResult,
} from "./application/contracts/model-control-ports.js";
export type {
  CanonicalModelInventory,
  ModelProduct,
  ModelRouteRole,
} from "./domain/model-catalog.js";
export type { SiteModelPolicy } from "./domain/site-model-policy.js";

export const modelControlPlatformModule = {
  id: "model",
  labelKey: "platform.modules.model",
  packageName: "kokoro-platform",
  directory: "src/modules/model-control",
  status: "active",
  kind: "model-registry",
  storage: { primary: "postgresql", databaseEnv: "DATABASE_URL_PLATFORM", ownsMigrations: true },
  admin: { mode: "planned" },
  runtime: {
    surfaces: ["local-application"],
    notes: [
      "Global catalog releases and independently versioned Site model policies are separate local Platform application ports.",
      "Model execution remains a remote Model Gateway boundary; ModelControl never invokes providers inside its transaction.",
    ],
  },
  dependencies: ["site"],
  boundaries: {
    owns: [
      "canonical model inventory",
      "product model routes",
      "Site model assignment",
      "selection decision audit",
    ],
    doesNotOwn: [
      "provider execution",
      "credit pricing",
      "Session admission",
      "generated artifacts",
    ],
  },
} satisfies PlatformModuleDescriptor;
