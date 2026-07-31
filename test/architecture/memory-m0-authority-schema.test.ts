import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_DATABASE_ROLE_CONTRACTS, MEMORY_DEPLOYMENT_TYPES } from
  "../../src/modules/memory/infrastructure/memory-role-contract.js";

const migrationPath = join(process.cwd(),
  "prisma/migrations/20260808_memory_m0_authority_kernel/migration.sql");
const migration = readFileSync(migrationPath, "utf8");
const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const memoryIndex = readFileSync(join(process.cwd(), "src/modules/memory/INDEX.md"), "utf8");

describe("Memory M0 feature-off authority schema", () => {
  it("never repeats a SECURITY DEFINER clause inside one function declaration", () => {
    const functions = migration.match(/CREATE FUNCTION[\s\S]*?\$function\$;/gu) ?? [];
    expect(functions.length).toBeGreaterThan(0);
    for (const declaration of functions) {
      expect(declaration.match(/\bSECURITY DEFINER\b/gu) ?? []).toHaveLength(
        declaration.includes("validate_memory_command_actor_authority") ||
          declaration.includes("validate_memory_scope_authority") ? 1 : 0,
      );
    }
  });

  it("creates the five owner tables with Site-local scope and protected revision payloads", () => {
    for (const table of ["memory_space", "memory_entry", "memory_revision", "memory_provenance",
      "memory_command_receipt"]) {
      expect(migration).toContain(`CREATE TABLE platform.${table}`);
      expect(migration).toContain(`ALTER TABLE platform.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE platform.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE platform.${table} FROM PUBLIC`);
    }
    expect(migration).toContain("scope_kind IN ('user','project','agent_product')");
    expect(migration).not.toMatch(/scope_kind[^\n]*workspace/u);
    expect(migration).toContain("FOREIGN KEY (subject_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY (project_ref,site_ref)");
    expect(migration).toContain("FOREIGN KEY (actor_project_ref,actor_subject_ref)");
    expect(migration).toContain("FOREIGN KEY (owner_project_ref,caller_subject_ref)");
    expect(migration).toContain("FOREIGN KEY (site_ref,parent_space_ref)");
    expect(migration).toContain("UNIQUE NULLS NOT DISTINCT (site_ref,scope_kind,parent_space_ref");
    expect(migration).toContain("UNIQUE (site_ref,entry_ref)");
    const memorySpaceDdl = migration.slice(migration.indexOf("CREATE TABLE platform.memory_space"),
      migration.indexOf("CREATE TABLE platform.memory_entry"));
    expect(memorySpaceDdl).not.toMatch(/membership_epoch|authorization_epoch/u);
    expect(memorySpaceDdl).toContain("scope_kind='project' AND parent_space_ref IS NULL AND parent_space_generation IS NULL");
    expect(memorySpaceDdl).toContain("parent_learning_generation IS NULL AND parent_revocation_epoch IS NULL");
    expect(memorySpaceDdl).toContain("parent_space_generation BIGINT");
    expect(migration).toContain("actor_membership_epoch BIGINT");
    expect(migration).toContain("caller_authorization_epoch BIGINT");
    expect(migration).toContain("CREATE FUNCTION platform.validate_memory_command_actor_authority()");
    expect(migration).toContain("membership.membership_epoch=actor_membership_epoch");
    expect(migration).toContain("release.feature_policy_revision=NEW.feature_policy_revision_ref");
    expect(migration).toContain("protected_ciphertext BYTEA");
    expect(migration).toContain("protection_key_revision TEXT");
    expect(migration).toContain("envelope_digest CHAR(64)");
    expect(migration).not.toMatch(/(?:plain|canonical)_?content\s+(?:TEXT|JSONB)/iu);
  });

  it("enforces append-only history, receipt immutability, and current-revision lineage/CAS", () => {
    expect(migration).toContain("CREATE FUNCTION platform.reject_memory_immutable_mutation()");
    for (const table of ["memory_revision", "memory_provenance", "memory_command_receipt"]) {
      expect(migration).toContain(`BEFORE UPDATE OR DELETE ON platform.${table}`);
    }
    expect(migration).toContain("FOREIGN KEY (site_ref,space_ref,entry_ref,current_revision,current_revision_ref)");
    expect(migration).toContain("FOREIGN KEY (site_ref,space_ref,entry_ref,supersedes_revision,supersedes_revision_ref)");
    expect(migration).toContain("NEW.current_revision=OLD.current_revision+1");
    expect(migration).toContain("NEW.version<>OLD.version+1");
    expect(migration).toContain("NEW.revocation_epoch<OLD.revocation_epoch");
    expect(migration).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(migration).toContain("result_kind IN ('remembered','corrected','forgotten',");
    expect(migration).toContain("'rebind_policy'");
    expect(migration).toContain("result_kind='policy_rebound'");
    expect(migration).toContain("result_previous_feature_policy_revision_ref TEXT");
    expect(migration).toContain("CREATE FUNCTION platform.validate_memory_entry_current_fence()");
    expect(migration).toContain("BEFORE INSERT OR UPDATE ON platform.memory_entry");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF feature_policy_revision_ref ON platform.memory_space");
    expect(migration).toContain("BEFORE INSERT OR UPDATE ON platform.memory_space");
    expect(migration).not.toContain("result JSONB");
  });

  it("registers dormant role kinds without creating roles, authority rows, grants, or a platform_api escape", () => {
    expect(MEMORY_DATABASE_ROLE_CONTRACTS).toEqual([
      { roleKind: "memory_public", futureLoginRole: "platform_memory_public" },
      { roleKind: "memory_runtime", futureLoginRole: "platform_memory_runtime" },
      { roleKind: "memory_worker", futureLoginRole: "platform_memory_worker" },
    ]);
    expect(MEMORY_DEPLOYMENT_TYPES).toEqual([
      "platform-api", "platform-memory-runtime", "platform-memory-worker",
    ]);
    for (const kind of ["memory_public", "memory_runtime", "memory_worker"]) {
      expect(migration).toContain(`'${kind}'`);
    }
    expect(migration).not.toMatch(/CREATE ROLE platform_memory_/u);
    expect(migration).not.toMatch(/INSERT INTO platform\.runtime_role_identity_authority/u);
    expect(migration).not.toMatch(/GRANT .+ TO (?:"?platform_api"?|"?platform_memory_)/u);
    expect(migration).not.toContain("CREATE FUNCTION platform.memory_role_identity_is_current");
    expect(migration).not.toMatch(/CREATE POLICY [^\n]+ ON platform\.memory_/u);
    expect(migration).not.toContain("current_setting('app.site_id'");
    expect(memoryIndex).toContain("adding grants alone cannot make Memory owner tables accessible");
  });

  it("maps all owner tables into Prisma without adding an active Memory process surface", () => {
    for (const model of ["MemorySpace", "MemoryEntry", "MemoryRevision", "MemoryProvenance",
      "MemoryCommandReceipt"]) expect(schema).toContain(`model ${model} {`);
    const memorySchema = schema.slice(schema.indexOf("model MemorySpace {"),
      schema.indexOf("model CommandReceipt {"));
    expect(memorySchema).not.toContain("workspaceRef");
    const processSources = readdirSync(join(process.cwd(), "src/process"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(process.cwd(), "src/process", name), "utf8"))
      .join("\n");
    expect(processSources).not.toMatch(/modules\/memory|platform-memory/u);
    expect(readFileSync(join(process.cwd(), "package.json"), "utf8"))
      .not.toMatch(/start:memory|start:platform-memory/u);
    expect(readFileSync(join(process.cwd(), "deployables.yaml"), "utf8"))
      .not.toMatch(/platform-memory/u);
  });
});
