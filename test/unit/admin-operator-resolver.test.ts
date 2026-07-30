import { describe, expect, it } from "vitest";
import { PostgresAdminOperatorResolver } from
  "../../src/modules/admin/infrastructure/postgres/admin-operator-resolver.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres Admin operator bootstrap resolver", () => {
  it("returns complete authority hints inside the operator RLS fence", async () => {
    const statements: string[] = [];
    const resolver = new PostgresAdminOperatorResolver({
      async adminIdentityTransaction(_fence, work) {
        const lease = issuePlatformTransaction({
          async query<Row extends Record<string, unknown>>(statement: string) {
            statements.push(statement);
            if (statement.includes("admin_operator_identity")) return [{ operatorRef: "operator:1",
              operatorGeneration: "2", operatorSecurityEpoch: "4", restrictionEpoch: "6", policyEpoch: "6",
              permissions: ["commerce.offer.read"], expiresAt: new Date("2030-01-01T00:00:00.000Z") }] as unknown as Row[];
            if (statement.includes("admin_operator_site_scope")) return [{ siteRef: "site:1", environment: "production",
              region: "us-east-1", scopeEpoch: "3", expiresAt: new Date("2030-01-01T00:00:00.000Z") }] as unknown as Row[];
            return [] as Row[];
          },
          async execute() { return 0; },
        });
        try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
      },
    });
    await expect(resolver.resolve({ issuer: "https://issuer.test", subject: "subject", audience: "audience",
      nonce: "nonce", authenticationTime: "2026-07-29T00:00:00.000Z", assuranceLevel: "mfa",
      factorClasses: ["totp"], managedDeviceRef: "device:1" }, {
      workloadIdentityRef: "spiffe://kokoro/web/admin", environment: "production", region: "us-east-1",
      managedDeviceRef: "device:1", audience: "platform-admin",
    })).resolves.toMatchObject({ operatorRef: "operator:1", permissions: ["commerce.offer.read"],
      siteScopes: [{ siteRef: "site:1", scopeEpoch: 3n }] });
    expect(statements[1]).toContain("set_config('app.subject_id'");
  });
});
