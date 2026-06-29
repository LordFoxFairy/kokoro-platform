import { registerAdminManifestRoute, sendData } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { ModelRepository } from "../../domain/repository.js";
import { modelAdminManifest } from "../admin/manifest.js";

export function registerModelAdminRoutes(app: FastifyInstance, repository: ModelRepository): void {
  registerAdminManifestRoute(app, modelAdminManifest);

  app.get("/admin/models/provider-accounts", async (_request, reply) =>
    sendData(reply, await repository.listProviderAccounts()),
  );

  app.get("/admin/models/bindings", async (_request, reply) =>
    sendData(reply, await repository.listAllModelBindings()),
  );

  app.get("/admin/models/labels", async (_request, reply) =>
    sendData(reply, await repository.listModelLabels()),
  );
}
