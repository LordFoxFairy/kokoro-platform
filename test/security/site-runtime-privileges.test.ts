import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrator = readFileSync(
  new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url),
  "utf8",
);
const client = readFileSync(
  new URL("../../src/infrastructure/postgres/client.ts", import.meta.url),
  "utf8",
);

describe("Site runtime privileges", () => {
  it("grants worker only the owner projections required by durable reconciliation", () => {
    expect(migrator).toContain(
      "platform.site_deployment_binding, platform.site_deployment_observation, platform.site_traffic_stop_observation",
    );
    expect(migrator).toContain(
      "platform.authorization_site, platform.authorization_site_release, platform.authorization_product_binding",
    );
    expect(migrator).toContain(
      "UPDATE(state,provider_operation_key,deployment_ref,observed_at,failure_code,updated_at) ON TABLE platform.site_activation_attempt",
    );
    expect(migrator).toContain(
      "UPDATE(state,provider_operation_key,observed_at,failure_code,updated_at) ON TABLE platform.site_traffic_stop_attempt",
    );
  });

  it("grants admin maker-checker and admission writes without exposing approvals to API", () => {
    expect(migrator).toContain(
      "platform.site_activation_attempt, platform.site_traffic_stop_attempt, platform.site_effect_approval",
    );
    expect(migrator).toContain(
      "UPDATE(state,checker_subject_ref,decided_at,consumed_request_id,consumed_at,updated_at) ON TABLE platform.site_effect_approval",
    );
    const apiBranch = migrator.slice(
      migrator.indexOf("if (role === apiRole)"),
      migrator.indexOf("} else if (role === authorizationRole)"),
    );
    expect(apiBranch).not.toContain("SITE_TABLES");
    expect(apiBranch).not.toContain("site_effect_approval");
  });

  it("fails process startup and post-migration verification when Site grants drift", () => {
    for (const source of [migrator, client]) {
      expect(source).toContain("'platform.site_traffic_stop_attempt', 'SELECT'");
      expect(source).toContain("'platform.site_traffic_stop_observation', 'SELECT,INSERT'");
      expect(source).toContain("'platform.site_effect_approval', 'SELECT,INSERT'");
      expect(source).toContain("'platform.authorization_product_binding', 'SELECT,INSERT'");
      expect(source).toContain("'platform.authorization_site_release', 'SELECT,INSERT'");
      expect(source).toContain("candidate.relname<>'site_effect_approval'");
    }
  });
});
