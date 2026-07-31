import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = "prisma/migrations/20260810_media_worker_runtime/migration.sql";
const operationMigrationPath = "prisma/migrations/20260809_media_artifact_image_vertical/migration.sql";

describe("Media worker runtime PostgreSQL authority", () => {
  it("uses reclaimable SKIP LOCKED leases with exact epoch and capability fences", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toMatch(/state='pending'[\s\S]+state='leased'[\s\S]+lease_expires_at<=statement_timestamp\(\)/u);
    for (const routine of ["claim_media_image_task_v2", "renew_media_image_task",
      "return_media_image_worker_leases", "retry_or_dead_letter_media_image_task"]) {
      expect(migration).toContain(`platform.${routine}`);
    }
    expect(migration).toMatch(/lease_epoch=p_lease_epoch[\s\S]+lease_token_hash=p_lease_token_hash/u);
    expect(migration).toContain("attempt_count=GREATEST(attempt_count-1,0)");
  });

  it("journals Gateway ambiguity and immutable saga/dead-letter receipts before state changes", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const relation of ["media_gateway_effect_journal", "media_gateway_effect_evidence",
      "media_gateway_cancel_journal",
      "media_worker_saga_receipt", "media_worker_dead_letter",
      "media_artifact_cleanup_dead_letter"]) expect(migration).toContain(`platform.${relation}`);
    for (const routine of ["prepare_media_image_gateway_effect", "record_media_image_gateway_view",
      "record_media_image_gateway_owner_view", "record_media_image_gateway_evidence_page",
      "prepare_media_image_gateway_cancel", "record_media_image_gateway_cancel_result",
      "record_media_image_gateway_cancel_outcome_unknown",
      "record_media_image_outcome_unknown", "record_media_image_saga_receipt", "complete_media_image_task"]) {
      expect(migration).toContain(`platform.${routine}`);
    }
    expect(migration).toContain("MEDIA_WORKER_EFFECT_RECEIPT_IMMUTABLE");
    expect(migration).toContain("MEDIA_WORKER_DEAD_LETTER_IMMUTABLE");
    expect(migration).toContain("late_cancellation_observed");
    expect(migration).not.toContain("bytesBase64");
    expect(migration).toContain("caller_access_capability_envelope");
    expect(migration).toContain("model_option_authorization_capability_envelope");
    expect(migration).toContain("gateway_create_effect_digest=operation.gateway_caller_request_fingerprint");
    expect(migration).not.toContain("provider_effect_ref");
  });

  it("persists Trust restriction as exact Candidate evidence without an Artifact ready reference", async () => {
    const migration = await readFile(migrationPath, "utf8");
    const operationMigration = await readFile(operationMigrationPath, "utf8");
    expect(operationMigration).toMatch(/media_operation[\s\S]+partial_completion TEXT NOT NULL/u);
    expect(operationMigration).toMatch(/media_operation[\s\S]+minimum_ready_candidates INTEGER NOT NULL/u);
    expect(migration).toContain("partial_completion");
    expect(migration).toContain("minimum_ready_candidates");
    expect(migration).toMatch(
      /'definitionPolicy'[\s\S]+operation\.partial_completion[\s\S]+operation\.minimum_ready_candidates/u,
    );
    expect(migration).toContain("restriction_receipt_ref");
    expect(migration).toMatch(/p_step='trust_decision'[\s\S]+p_receipt->>'kind'='restrict'[\s\S]+state='restricted'/u);
    expect(migration).toMatch(/ready_object_ref=CASE WHEN p_receipt->>'kind'='restrict' THEN NULL/u);
    expect(migration).toContain("terminal_failure");
    expect(migration).toMatch(/candidate\.gateway_output_evidence_ref=failure->>'outputEvidenceRef'/u);
    expect(migration).toContain("media_operation_credit_terminal_gate");
  });

  it("binds financial closure to the frozen Credit unit and conserves the reserved ceiling", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("p_step='financial_closure'");
    expect(migration).toContain("operation.credit_unit=p_receipt->>'unit'");
    expect(migration).toMatch(
      /operation\.credit_reserved_ceiling=\s*\(p_receipt->>'actualCost'\)::NUMERIC\+\s*\(p_receipt->>'releasedCredit'\)::NUMERIC/u,
    );
    expect(migration).toMatch(
      /effect_closure_receipt_ref[\s\S]+financial_receipt_ref[\s\S]+allocation_closure_receipt_ref[\s\S]+terminal_receipt_ref/u,
    );
  });

  it("keeps staged cleanup as independently leased retryable owner work", async () => {
    const migration = await readFile(migrationPath, "utf8");
    for (const routine of ["claim_media_artifact_cleanup", "renew_media_artifact_cleanup",
      "complete_media_artifact_cleanup", "retry_media_artifact_cleanup",
      "return_media_artifact_cleanup_leases"]) {
      expect(migration).toContain(`platform.${routine}`);
    }
    expect(migration).toContain("staged_cleanup_state='pending'");
    expect(migration).toContain("staged_cleanup_lease_epoch");
    expect(migration).toContain("staged_cleanup_next_attempt_at");
  });

  it("gives the worker no direct table privileges", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]{0,200}\bTO\s+platform_media_worker\b/iu);
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION");
    expect(migration).toContain("TO platform_media_worker");
    expect(migration).toContain("PERFORM platform.assert_media_runtime_role('worker')");
  });
});
