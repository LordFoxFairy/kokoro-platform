import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL(
  "../../prisma/migrations/20260729_asset_upload_authority/migration.sql",
  import.meta.url,
), "utf8");
const migrator = readFileSync(new URL(
  "../../src/infrastructure/postgres/migrator.ts",
  import.meta.url,
), "utf8");
const databaseClient = readFileSync(new URL(
  "../../src/infrastructure/postgres/client.ts",
  import.meta.url,
), "utf8");

describe("Asset persistence authority", () => {
  it("freezes the observed provider version and binds candidates to their scan event", () => {
    expect(migration).toContain("CREATE TABLE platform.asset_blob_candidate");
    expect(migration).toContain("provider_version_ref TEXT NOT NULL");
    expect(migration).toContain("scan_event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id)");
    expect(migration).toContain("CHECK (observed_at >= completion_requested_at)");
    expect(migration).toContain("CREATE TABLE platform.asset_upload_rejection");
    expect(migration).toContain("CREATE TRIGGER asset_upload_rejection_immutable");
    expect(migration).toContain("CREATE TABLE platform.asset_scan_evaluation");
    expect(migration).toContain("CREATE TRIGGER asset_scan_evaluation_immutable");
    expect(migration).toContain("CREATE TABLE platform.asset_promotion_intent");
    expect(migration).toContain("CREATE TRIGGER asset_promotion_intent_update_guard");
    expect(migration).toContain("CREATE TABLE platform.asset_cleanup_group");
    expect(migration).toContain("CREATE TABLE platform.asset_object_cleanup");
    expect(migration).toContain("CREATE TABLE platform.asset_object_cleanup_receipt");
    expect(migration).toContain("provider_version_ref TEXT NOT NULL");
    expect(migration).toContain("CREATE TRIGGER asset_object_cleanup_receipt_immutable");
    expect(migration).toContain("'trash_retained'");
  });

  it("gives only the Platform worker write authority over candidates and rejection facts", () => {
    expect(migrator).toContain("const ASSET_TABLES");
    expect(migrator).toContain(
      "GRANT INSERT ON TABLE platform.outbox_event, platform.asset_blob_candidate, platform.asset_cleanup_group, platform.asset_object_cleanup, platform.asset_object_cleanup_receipt, platform.asset_upload_rejection",
    );
    expect(migrator).toContain(
      "GRANT UPDATE ON TABLE platform.asset_upload_intent, platform.asset_upload_session, platform.asset_quota_account, platform.asset_quota_reservation, platform.asset_blob_candidate, platform.asset_cleanup_group, platform.asset_object_cleanup",
    );
    expect(databaseClient).toContain('"asset.upload-completion.observe"');
    expect(databaseClient).toContain('"asset.scan.evaluate"');
    expect(databaseClient).toContain('"asset.cleanup.delete"');
    expect(databaseClient).toContain("config.role !== \"worker\"");
    expect(databaseClient).toContain('scope.scopes[0] !== "asset:worker"');
  });

  it("forces Site-scoped row policies for candidate and rejection storage", () => {
    expect(migration).toContain("ALTER TABLE platform.asset_blob_candidate FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_upload_rejection FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_scan_evaluation FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_promotion_intent FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_cleanup_group FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_object_cleanup FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE platform.asset_object_cleanup_receipt FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("CREATE POLICY asset_blob_candidate_worker_scope");
    expect(migration).toContain("CREATE POLICY asset_upload_rejection_worker_scope");
    expect(migration).toContain("CREATE POLICY asset_object_cleanup_worker_scope");
    expect(migration).toContain("CREATE POLICY asset_object_cleanup_receipt_worker_scope");
    expect(migration).toContain("site_ref=NULLIF(current_setting('app.site_id',true),'')");
    expect(migration).toContain("current_setting('app.workload_kind',true)='platform_worker'");
    expect(migration).toContain("current_setting('app.scopes',true),'[]')::JSONB ? 'asset:worker'");
  });
});
