import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPLIT_WORKER_RELATION_AUTHORITY, SPLIT_WORKER_RLS_AUTHORITY } from
  "../../src/infrastructure/postgres/split-worker-authority.js";

const migrator = readFileSync(
  new URL("../../src/infrastructure/postgres/migrator.ts", import.meta.url),
  "utf8",
);
const client = readFileSync(
  new URL("../../src/infrastructure/postgres/client.ts", import.meta.url),
  "utf8",
);

describe("Site runtime privileges", () => {
  it("grants the Site worker only the owner projections required by durable reconciliation", () => {
    const authority = SPLIT_WORKER_RELATION_AUTHORITY["site-worker"];
    for (const relation of [
      "site_deployment_binding", "site_deployment_observation",
      "site_traffic_stop_observation", "authorization_site",
      "authorization_site_release", "authorization_product_binding",
    ]) expect(authority).toContainEqual({ relation, privilege: "INSERT" });
    expect(authority).toContainEqual({
      relation: "site_activation_attempt",
      privilege: "UPDATE",
      columns: [
        "state", "provider_operation_key", "deployment_ref", "observed_at", "failure_code",
        "updated_at",
      ],
    });
    expect(authority).toContainEqual({
      relation: "site_traffic_stop_attempt",
      privilege: "UPDATE",
      columns: [
        "state", "provider_operation_key", "observed_at", "failure_code", "updated_at",
      ],
    });
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

  it("fails startup and post-migration verification when exact Site grants drift", () => {
    const relations = new Set(SPLIT_WORKER_RELATION_AUTHORITY["site-worker"]
      .map((authority) => authority.relation));
    for (const relation of [
      "site_traffic_stop_attempt", "site_traffic_stop_observation",
      "authorization_product_binding", "authorization_site_release",
    ]) expect(relations).toContain(relation);
    for (const relation of ["site_effect_approval", "asset_upload_intent", "admin_approval"]) {
      expect(relations).not.toContain(relation);
    }
    expect(SPLIT_WORKER_RLS_AUTHORITY["site-worker"].policies.map(([relation]) => relation))
      .not.toContain("site_effect_approval");
    expect(migrator).toContain("SPLIT_WORKER_EXACT_AUTHORITY_SQL");
    expect(client).toContain("SPLIT_WORKER_EXACT_AUTHORITY_SQL");
  });
});
