import { registerAdminManifestRoute, sendData } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { CreditRepository } from "../../domain/repository.js";
import { creditAdminManifest } from "../admin/manifest.js";

export function registerCreditAdminRoutes(app: FastifyInstance, repository: CreditRepository): void {
  registerAdminManifestRoute(app, creditAdminManifest);

  app.get("/admin/credits/accounts", async (_request, reply) =>
    sendData(reply, await repository.listAccounts()),
  );

  app.get("/admin/credits/ledger", async (_request, reply) =>
    sendData(reply, await repository.listLedgerEntries()),
  );

  app.get("/admin/credits/usage", async (_request, reply) =>
    sendData(reply, await repository.listUsageRecords()),
  );

  app.get("/admin/credits/pricing", async (_request, reply) =>
    sendData(reply, await repository.listPricingRules()),
  );
}
