import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../prisma/migrations/20260808_media_child_allocation_authority/migration.sql",
  import.meta.url,
);

describe("Credit Media child allocation authority schema", () => {
  it("fails fast on unsupported legacy data before the first schema mutation", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const executable = sql.replace(/^--.*$/gmu, "").trim();
    expect(executable.startsWith("BEGIN;"), "BEGIN must be the first executable statement").toBe(true);
    expect(executable.endsWith("COMMIT;"), "COMMIT must be the last executable statement").toBe(true);
    expect(sql.match(/^BEGIN;$/gmu)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gmu)).toHaveLength(1);
    const preflight = sql.indexOf("CREDIT_MEDIA_CHILD_MIGRATION_REQUIRES_FRESH_DATA");
    const firstMutation = Math.min(
      ...["ALTER TABLE", "CREATE TABLE", "DROP TABLE", "CREATE FUNCTION"]
        .map((statement) => sql.indexOf(statement))
        .filter((position) => position >= 0),
    );
    expect(preflight).toBeGreaterThan(sql.indexOf("BEGIN;"));
    expect(preflight).toBeLessThan(firstMutation);
    expect(sql).toContain("allocation.audience='job'");
    expect(sql).toContain("platform.credit_allocation_reservation_receipt");
    expect(sql).toContain("platform.credit_allocation_return_receipt");
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE\s+FROM)\s+platform\.credit_/iu);
    expect(sql).not.toContain("DROP TRIGGER credit_allocation_reservation_receipt_immutable");
    expect(sql).not.toContain("DROP TRIGGER credit_allocation_return_receipt_immutable");
    expect(sql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY|\bVACUUM\b|ALTER\s+SYSTEM/iu);
  });

  it("hard-cuts the fresh schema to formal Media without a legacy backfill", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const audienceConstraint = sql.indexOf("ADD CONSTRAINT credit_budget_allocation_audience_check");
    expect(audienceConstraint).toBeGreaterThan(0);
    expect(sql).toContain("DROP CONSTRAINT credit_budget_allocation_audience_check");
    expect(sql).toContain("'root','model_gateway','capability_runtime','media','agent_team','target_runtime'");
    const finalAudienceConstraint = sql.slice(
      audienceConstraint,
      sql.indexOf("ALTER TABLE platform.credit_allocation_reservation_receipt"),
    );
    expect(finalAudienceConstraint).not.toMatch(/['"]job['"]/u);
    expect(sql).toContain("purpose='media_operation'");
    expect(sql).toContain("capability_key");
    expect(sql).toContain("expires_at");
  });

  it("binds reservation and return receipts to exact revisions, epochs, scope, and owner evidence", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (const field of [
      "parent_expected_epoch",
      "child_initial_epoch",
      "parent_expected_revision",
      "child_expected_revision",
      "child_expected_epoch",
      "media_operation_ref",
      "owner_closure_evidence_ref",
    ]) expect(sql).toContain(field);
    expect(sql).toContain("child_terminal_revision=child_expected_revision+1");
    expect(sql).toContain("fence_epoch=child_expected_epoch+1");
    expect(sql).toContain("child_fact.parent_allocation_ref IS DISTINCT FROM NEW.parent_allocation_ref");
    expect(sql).toContain("NOT parent_fact.is_root OR parent_fact.audience<>'root'");
    expect(sql).toContain("child_initial_epoch IS NULL OR child_initial_epoch>0");
    expect(sql).toContain("child_expected_epoch IS NULL OR child_expected_epoch>=0");
    expect(sql).toContain("audience IS DISTINCT FROM 'media'");
    expect(sql).toContain("captured_amount");
    expect(sql).toContain("owner_closure_outcome");
    expect(sql).toContain("root_state_at_return");
    expect(sql).toContain("reason='canceled_before_effect'");
    expect(sql).toContain("owner_closure_outcome='canceled' AND captured_amount=0");
    expect(sql).not.toContain("ADD COLUMN media_operation_ref TEXT NOT NULL");
    expect(sql).not.toContain("ADD COLUMN owner_closure_evidence_ref TEXT NOT NULL");
    expect(sql).not.toMatch(/ALTER COLUMN (?:parent_expected_epoch|child_initial_epoch|audience|parent_expected_revision|child_expected_revision|child_expected_epoch) SET NOT NULL/u);
    expect(sql).toContain("CREDIT_MEDIA_CHILD_RESERVATION_METADATA_INVALID");
    expect(sql).toContain("CREDIT_MEDIA_CHILD_RETURN_FENCE_INVALID");
  });

  it("closes SQL NULL truth-table holes and uses full composite revision fences", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const childScope = sql.slice(
      sql.indexOf("ADD CONSTRAINT credit_budget_operation_receipt_child_scope_check"),
      sql.indexOf("CREATE FUNCTION platform.guard_credit_media_allocation_metadata_update"),
    );
    for (const field of [
      "parent_before_revision",
      "parent_after_revision",
      "child_before_revision",
      "child_after_revision",
      "credit_amount",
    ]) {
      expect(childScope).toMatch(new RegExp(`${field} IS NOT NULL`, "u"));
    }
    expect(childScope.match(/MATCH FULL/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("guards the exact root and hold states and provides the terminal-return index", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("hold_fact platform.credit_hold%ROWTYPE");
    expect(sql).toContain("root_fact.state<>'open'");
    expect(sql).toContain("hold_fact.state<>'open'");
    expect(sql).toContain("hold_fact.state NOT IN ('open','closing')");
    expect(sql).toContain("credit_budget_operation_receipt_return_child_latest_idx");
    expect(sql).toContain("(site_ref,child_allocation_ref,completed_at DESC)");
    expect(sql).toContain("WHERE operation_kind='return_media_child'");
  });

  it("uses the existing operation receipt without creating an unrouted child outbox event", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toContain("'derive_media_child','return_media_child'");
    expect(sql).toContain("ALTER COLUMN outbox_event_ref DROP NOT NULL");
    expect(sql).not.toContain("DROP CONSTRAINT outbox_event_check");
    expect(sql).not.toContain("credit.derive_media_child.v1");
    expect(sql).not.toContain("credit.return_media_child.v1");
    expect(sql).toContain("ALTER COLUMN authorization_segment_ref DROP NOT NULL");
    expect(sql).toContain("parent_before_revision");
    expect(sql).toContain("parent_after_revision");
    expect(sql).toContain("child_before_revision");
    expect(sql).toContain("child_after_revision");
    expect(sql).toContain("credit_amount");
    expect(sql).not.toContain("CREATE TABLE platform.media");
    expect(sql).not.toContain("CREATE TABLE platform.credit_media_ledger");
    expect(sql).not.toContain("CREATE TABLE platform.credit_media_queue");
  });

  it("keeps Media free of direct Credit DML", async () => {
    const mediaRoot = new URL("../../src/modules/media/", import.meta.url);
    const files = (await readdir(mediaRoot, { recursive: true }))
      .filter((path) => path.endsWith(".ts"));
    const source = (await Promise.all(files.map((path) => readFile(new URL(path, mediaRoot), "utf8")))).join("\n");
    expect(source).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\.credit_/iu);
    expect(source).not.toContain("credit-authority-repository");
  });

  it("documents only the current Media integration and child event routing facts", async () => {
    const index = await readFile(new URL("../../src/modules/credit/INDEX.md", import.meta.url), "utf8");
    expect(index).toContain("wired into Media image submission through the native same-transaction owner");
    expect(index).toContain("direct-root terminal authority and its production");
    expect(index).toContain("remain fail-closed launch blockers");
    expect(index).toContain("do not emit an outbox event because no routed consumer exists");
    expect(index).not.toContain("Media callers consume the typed");
    expect(index).not.toContain("current pure Media domain kernel is not wired");
  });

  it("keeps Credit canonical ordering independent of process locale", async () => {
    const creditRoot = new URL("../../src/modules/credit/", import.meta.url);
    const files = (await readdir(creditRoot, { recursive: true }))
      .filter((path) => path.endsWith(".ts"));
    const source = (await Promise.all(files.map((path) => readFile(new URL(path, creditRoot), "utf8")))).join("\n");
    expect(source).not.toContain("localeCompare");
  });

  it("keeps Media child orchestration, SQL, row mapping, and receipt codecs in narrow internal modules", async () => {
    const files = await Promise.all([
      "../../src/modules/credit/application/credit-service.ts",
      "../../src/modules/credit/application/media-child-allocation-service.ts",
      "../../src/modules/credit/application/media-child-command.ts",
      "../../src/modules/credit/application/media-child-receipt-codec.ts",
      "../../src/modules/credit/infrastructure/postgres/credit-authority-repository.ts",
      "../../src/modules/credit/infrastructure/postgres/media-child-allocation-sql.ts",
      "../../src/modules/credit/infrastructure/postgres/media-child-allocation-row.ts",
    ].map(async (path) => readFile(new URL(path, import.meta.url), "utf8")));
    const [service = "", orchestration = "", command = "", codec = "", repository = "", sql = "", row = ""] = files;
    expect(service.split("\n").length).toBeLessThan(400);
    expect(repository.split("\n").length).toBeLessThan(1_200);
    expect(orchestration).toContain("class MediaChildAllocationService");
    expect(command).toContain("snapshotChildDerivation");
    expect(codec).toContain("buildReturnedMediaChildReceipt");
    expect(sql).toContain("credit-media-child-allocation-fresh-load");
    expect(row).toContain("mapMediaChildAllocationRow");
  });
});
