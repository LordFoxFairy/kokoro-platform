import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../../src/infrastructure/postgres/client.ts", import.meta.url), "utf8");
const migrator = readFileSync(new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url), "utf8");
const composition = readFileSync(new URL("../../src/process/admin-composition.ts", import.meta.url), "utf8");

describe("Admin Credit read-plane architecture", () => {
  it("uses an exact Site RLS transaction and grants the Admin role only read access", () => {
    expect(client).toContain("adminSiteQueryTransaction");
    expect(client).toMatch(/set_config\('app\.site_id',\$[0-9]+,true\)/u);
    expect(migrator).toContain("CREDIT_ADMIN_READ_TABLES");
    expect(migrator).toMatch(/GRANT SELECT ON TABLE \$\{CREDIT_ADMIN_READ_TABLES\} TO \$\{identifier\}/u);
    expect(migrator).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE).*CREDIT_ADMIN_READ_TABLES/u);
  });

  it("mounts Credit as a dedicated service without self-RPC", () => {
    expect(composition).toContain("router.service(AdminCreditService, creditService)");
    expect(composition).toContain("new PostgresAdminCreditReader(input.database)");
    expect(composition).not.toMatch(/AdminCommerceService, creditService/u);
  });
});
