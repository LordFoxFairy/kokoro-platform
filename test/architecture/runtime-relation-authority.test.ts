import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ADMIN_INSERT_RELATIONS,
  ADMIN_UPDATE_RELATIONS,
  ADMISSION_INSERT_RELATIONS,
  ADMISSION_MODEL_GATEWAY_SELECT_COLUMNS,
  ADMISSION_MODEL_GATEWAY_UPDATE_COLUMNS,
  ADMISSION_RELATIONS,
  ADMISSION_UPDATE_RELATIONS,
  CREDIT_USAGE_RELATIONS,
  MEDIA_CONTROL_ADMIN_RELATIONS,
  PRODUCT_CATALOG_ADMIN_RELATIONS,
  SITE_PUBLICATION_ADMIN_INSERT_RELATIONS,
  SITE_PUBLICATION_ADMIN_SELECT_RELATIONS,
  SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS,
  SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS,
  SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS,
  SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS,
} from "../../src/infrastructure/postgres/runtime-relation-authority.js";

const clientSource = source("../../src/infrastructure/postgres/client.ts");
const migratorSource = source("../../src/infrastructure/postgres/migrator.ts");

describe("PostgreSQL runtime relation authority contract", () => {
  it("keeps migration postflight and runtime connection audit on shared relation sets", () => {
    for (const implementation of [clientSource, migratorSource]) {
      expect(implementation).toContain('from "./runtime-relation-authority.js"');
      expect(implementation.match(/(?<!SITE_PUBLICATION_)ADMIN_INSERT_RELATIONS_SQL/g))
        .toHaveLength(3);
      expect(implementation.match(/(?<!SITE_PUBLICATION_)ADMIN_UPDATE_RELATIONS_SQL/g))
        .toHaveLength(3);
      expect(implementation).toContain("MEDIA_CONTROL_ADMIN_RELATIONS_SQL");
      expect(implementation).toContain("PRODUCT_CATALOG_ADMIN_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMIN_SELECT_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMIN_INSERT_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS_SQL");
      expect(implementation).toContain("SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS_SQL");
      expect(implementation).toContain("ADMISSION_MODEL_GATEWAY_SELECT_COLUMNS_SQL");
      expect(implementation).toContain("ADMISSION_MODEL_GATEWAY_UPDATE_COLUMNS_SQL");
      expect(implementation).toContain('AS "admissionModelGatewayAuthorityExact"');
    }
  });

  it("defines every shared relation set without duplicate authority entries", () => {
    for (const relations of [ADMISSION_RELATIONS, ADMISSION_INSERT_RELATIONS,
      ADMISSION_UPDATE_RELATIONS, CREDIT_USAGE_RELATIONS, MEDIA_CONTROL_ADMIN_RELATIONS,
      PRODUCT_CATALOG_ADMIN_RELATIONS, SITE_PUBLICATION_ADMIN_SELECT_RELATIONS,
      SITE_PUBLICATION_ADMIN_INSERT_RELATIONS, SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS,
      SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS,
      SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS, SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS,
      ADMIN_INSERT_RELATIONS, ADMIN_UPDATE_RELATIONS]) {
      expect(new Set(relations).size).toBe(relations.length);
    }
  });

  it("gives Admission only the relations needed by the machine Evidence authority", () => {
    expect(ADMISSION_MODEL_GATEWAY_SELECT_COLUMNS).toEqual([
      "site_ref",
      "execution_manifest_ref",
      "state",
      "authorization_handle",
    ]);
    expect(ADMISSION_MODEL_GATEWAY_UPDATE_COLUMNS).toEqual(["state", "updated_at"]);
    expect(SITE_PUBLICATION_ADMISSION_SELECT_RELATIONS).toEqual([
      "command_receipt",
      "site_project_binding",
      "site_release_candidate_authority",
      "site_release_candidate_authorization",
      "site_publication_revision",
      "site_release_producer_trust_revision",
      "site_release_checker_trust_revision",
      "site_release_provenance_attestation",
      "site_release_evidence_checker_decision",
    ]);
    expect(SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS).toEqual([
      "command_receipt",
      "site_publication_revision",
      "site_release_provenance_attestation",
      "site_release_evidence_checker_decision",
    ]);
    expect(SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS).toEqual(["command_receipt"]);
    expect(ADMISSION_INSERT_RELATIONS).toEqual(expect.arrayContaining(
      [...SITE_PUBLICATION_ADMISSION_INSERT_RELATIONS],
    ));
    expect(ADMISSION_UPDATE_RELATIONS).toEqual(expect.arrayContaining(
      [...SITE_PUBLICATION_ADMISSION_UPDATE_RELATIONS],
    ));
  });

  it("gives Admin the exact Site publication authority needed by the production owner", () => {
    expect(SITE_PUBLICATION_ADMIN_SELECT_RELATIONS).toEqual([
      "site_release_candidate_authority",
      "site_release_candidate_authorization",
      "site_publication_revision",
      "site_effective_access_authority_revision",
      "site_web_build_intent_issuer_revision",
      "site_web_build_intent_issuer_head",
      "site_web_build_intent_envelope",
      "site_release_producer_trust_revision",
      "site_release_certification_envelope",
    ]);
    expect(SITE_PUBLICATION_ADMIN_INSERT_RELATIONS).toEqual([
      "site_release_candidate_authority",
      "site_release_candidate_authorization",
      "site_publication_revision",
      "site_web_build_intent_envelope",
    ]);
    expect(SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS).toEqual([
      "site_release_candidate_authorization",
    ]);
    expect(ADMIN_INSERT_RELATIONS).toEqual(expect.arrayContaining(
      [...SITE_PUBLICATION_ADMIN_INSERT_RELATIONS],
    ));
    expect(ADMIN_UPDATE_RELATIONS).toEqual(expect.arrayContaining(
      [...SITE_PUBLICATION_ADMIN_UPDATE_RELATIONS],
    ));
    for (const implementation of [clientSource, migratorSource]) {
      expect(implementation).toContain('AS "hasRequiredSitePublicationPrivileges"');
    }
  });

  it("gives Admin exact publication writes without making Rating Policy mutable", () => {
    expect(ADMIN_INSERT_RELATIONS).toEqual(expect.arrayContaining([
      "commerce_credit_program_revision",
      "commerce_entitlement_template_revision",
      "credit_rating_policy_revision",
      "site_release_media_definition",
      "product_surface_catalog_revision",
      "launch_product_profile_revision",
      "product_catalog_publication_audit",
      "product_catalog_publication_receipt",
    ]));
    expect(ADMIN_UPDATE_RELATIONS).toContain("product_catalog_publication_head");
    expect(ADMIN_UPDATE_RELATIONS).not.toContain("credit_rating_policy_revision");
  });

  it("does not reject the exact Admin Model Catalog reads after validating them", () => {
    expect(clientSource).toContain('END AS "canSelectModelCatalogTable"');
    expect(clientSource).not.toContain("candidate.relname LIKE 'model\\\\_%'");
  });

  it("keeps Admission and Admin aware of the Media authority relations", () => {
    expect(ADMISSION_RELATIONS).toContain("admission_media_access_authorization");
    expect(ADMISSION_INSERT_RELATIONS).toContain("admission_media_access_authorization");
    expect(ADMISSION_UPDATE_RELATIONS).toContain("admission_media_access_authorization");
    expect(MEDIA_CONTROL_ADMIN_RELATIONS).toEqual([
      "media_operation_definition_revision",
      "site_release_media_definition",
    ]);
  });
});

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
