# Commerce/Credit Authority Hard-Cut Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Commerce/Credit recurring-program authority invariants while recurring public redemption, the window worker, and payment rails remain disabled.

**Architecture:** Commerce owns Program, Enrollment, Acquisition, correction orchestration, reconciliation, receipts, and outbox. Credit owns Account, Grant, Hold, Ledger and exposes narrow issuance/correction ports. PostgreSQL immutable facts and deferred exact-binding checks protect the cross-aggregate boundary.

**Tech Stack:** TypeScript 5.9, Node 24, Vitest, PostgreSQL migration SQL, Prisma migrator inventory, Buf/protoc-gen-es generated ConnectRPC mirrors.

---

## Chunk 1: Public Gate and Ownership

### Task 1: Keep recurring redemption feature-off

**Files:**
- Modify: `src/modules/commerce/domain/redemption-preview.ts`
- Modify: `test/unit/preview-redemption.test.ts`
- Modify: `test/unit/commerce-redemption-repository.test.ts`

- [ ] Add a failing test proving daily and period Program outputs are rejected while permanent remains supported.
- [ ] Run `pnpm exec vitest run test/unit/preview-redemption.test.ts test/unit/commerce-redemption-repository.test.ts --no-cache` and observe the recurring cases fail.
- [ ] Set `redemptionReleaseCapabilities.calendarWindowCreditAcquisition` false and make the exhaustive support function accept only permanent.
- [ ] Re-run the two suites and observe PASS.

### Task 2: Move Program authority into Commerce

**Files:**
- Create: `src/modules/commerce/application/contracts/credit-program.ts`
- Create: `src/modules/commerce/infrastructure/postgres/credit-program-repository.ts`
- Move into Commerce: `src/modules/credit/domain/credit-program-catalog.ts`
- Move into Commerce: `src/modules/credit/application/credit-program-catalog-service.ts`
- Move into Commerce: `src/modules/credit/application/contracts/credit-program-catalog.ts`
- Move into Commerce: `src/modules/credit/application/contracts/credit-program-catalog-reader.ts`
- Move into Commerce: `src/modules/credit/infrastructure/postgres/credit-program-catalog.ts`
- Move into Commerce: `src/modules/credit/infrastructure/postgres/credit-program-catalog-reader.ts`
- Move into Commerce: `src/modules/credit/infrastructure/protobuf/credit-program-codec.ts`
- Replace: `src/process/credit-owner-composition.ts` with Commerce catalog composition under `src/process/commerce-admin-composition.ts`
- Modify: `prisma/migrations/20260816_commerce_credit_program_catalog_owner/migration.sql`
- Modify: Commerce service, repository, reader, fulfillment, composition, and test imports returned by `rg "grant-program|credit-grant-program" src/modules/commerce src/process test/unit`
- Delete: `src/modules/credit/application/contracts/grant-program.ts`
- Delete: `src/modules/credit/infrastructure/postgres/credit-grant-program.ts`
- Modify: `src/modules/credit/INDEX.md`
- Modify: `src/modules/commerce/INDEX.md`
- Test: `test/architecture/module-imports.test.ts`
- Test: `test/unit/commerce-administration.test.ts`

- [ ] Add failing architecture assertions that Credit has no Program/catalog/domain/service/reader/codec/composition or catalog tables and Commerce exposes the complete Program owner stack.
- [ ] Run the focused tests and observe stale Credit ownership fail.
- [ ] Introduce branded Program revision/ref/digest types and a discriminated `CreditProgramWindow` union; move the complete catalog domain/service/contracts/readers/codec/composition and both catalog migrations/tables into Commerce naming.
- [ ] Update consumers and remove the Credit-owned files; use exhaustive switches for window validation.
- [ ] Re-run focused tests and observe PASS.

## Chunk 2: Persistence Invariants

### Task 3: Hard-cut Program, Term, Enrollment, Acquisition, and Grant schema

**Files:**
- Modify: `prisma/migrations/20260729_wave_2a_commerce_core/migration.sql`
- Modify: `src/infrastructure/postgres/client.ts`
- Modify: `src/infrastructure/postgres/migrator.ts`
- Modify: all Platform SQL references returned by `rg "credit_grant_program_revision" src test`
- Test: `test/unit/commerce-schema.test.ts`
- Test: `test/security/platform-worker-database-authority.test.ts`
- Test: `test/architecture/deployable-roles.test.ts`

- [ ] Add failing string/schema tests for `commerce_credit_program_revision`, bounded permanent duration, bucket/source iff, immutable term snapshot, non-null Enrollment base key, exact Acquisition columns, both deferred FK/trigger directions, and API direct/indirect privilege denial.
- [ ] Run the three focused suites and observe failures for each missing invariant.
- [ ] Rename the Program table and indexes into Commerce.
- [ ] Add version-1/digest Term snapshot fields and their immutable composite key.
- [ ] Add Enrollment branch checks and non-null base unique key; add Acquisition repeated binding fields, fixed `program_window` source, one-to-one uniqueness, and deferred exact Grant FK.
- [ ] Add table-owner immutable and deferrable cross-fact trigger functions on Acquisition and Grant.
- [ ] Replace the journal invariant with exhaustive permanent-relative and recurring-absolute branches.
- [ ] Revoke API/PUBLIC table, sequence, function, default, and indirect security-definer authority; keep the worker uncomposed and ungranted.
- [ ] Re-run focused suites and observe PASS.

### Task 4: Align application grant validation with the database

**Files:**
- Modify: `src/modules/credit/application/contracts/grant-issuance.ts`
- Modify: `src/modules/credit/infrastructure/postgres/credit-grant-issuer.ts`
- Modify: `test/unit/credit-grant-issuer.test.ts`
- Modify: `test/unit/fulfillment-issuer.test.ts`

- [ ] Add failing tests for permanent relative expiry, recurring exact `program_window`, and rejection of cross-combinations.
- [ ] Add boundary cases for duration 0, duration above 315,576,000, PostgreSQL upper/lower timestamp overflow, and canonical application timestamp overflow.
- [ ] Run both suites and observe expected validation failures.
- [ ] Express issuance as a discriminated union and validate exhaustively before SQL.
- [ ] Bind recurring receipts to exact Enrollment/account/Program/window/acquired facts.
- [ ] Re-run both suites and observe PASS.

## Chunk 3: Absolute Windows and Corrections

### Task 5: Resolve DST anchors as absolute candidates

**Files:**
- Modify: `src/modules/commerce/infrastructure/postgres/credit-program-window-repository.ts`
- Modify: `src/modules/commerce/application/contracts/credit-program-window-repository.ts`
- Modify: `test/unit/credit-program-window.test.ts`
- Create or modify: `test/unit/credit-program-window-postgres.test.ts`

- [ ] Add failing SQL-shape and repository tests for normal dates, spring gap transition-end, overlap fold one/fold two, non-hour transitions, exact anchor, and acquisition clipping.
- [ ] Add failing period tests proving the Enrollment resolves an exact immutable Subscription Term ref/version/digest, starts at the frozen term start, ends at `min(term end, start + positive duration)`, and an already-ended period is skipped without reacquisition.
- [ ] Run the focused window suites and observe the old wall-clock comparison fail.
- [ ] Enumerate zone offsets around each civil date, round-trip absolute candidates, choose transition end for gaps, sort, and select `max(candidate <= acquiredAt)` plus the next absolute candidate.
- [ ] Resolve period windows only from the frozen term identity and reject any ref/version/digest or start/end mismatch before issuance.
- [ ] Record all exact binding columns in Acquisition.
- [ ] Re-run focused window suites and observe PASS.

### Task 6: Complete Enrollment revocation and Credit correction

**Files:**
- Create: `src/modules/commerce/application/contracts/credit-program-enrollment-repository.ts`
- Create: `src/modules/commerce/application/services/revoke-credit-program-enrollment.ts`
- Create: `src/modules/commerce/infrastructure/postgres/credit-program-enrollment-repository.ts`
- Modify: `src/modules/credit/application/contracts/source-correction.ts`
- Modify: `src/modules/credit/infrastructure/postgres/source-correction.ts`
- Modify: `src/modules/commerce/infrastructure/postgres/redemption-confirmation-repository.ts`
- Modify: `prisma/migrations/20260729_wave_2a_commerce_core/migration.sql`
- Test: `test/unit/credit-source-correction.test.ts`
- Test: `test/unit/commerce-credit-enrollment-revocation.test.ts`
- Test: `test/unit/confirm-redemption-postgres.test.ts`

- [ ] Add failing tests for first revoke, same-command replay, conflicting digest, multiple Grants with Grant-specific operation keys, positive available revoke, zero available no journal, active Hold partial correction, captured/consumed reconciliation, receipt recovery, and outbox/audit closure.
- [ ] Run the three suites and observe missing mutation/state-machine failures.
- [ ] Implement typed Credit correction outcomes and balanced available-to-revoked journal entries without Grant mutation.
- [ ] Implement Enrollment `FOR UPDATE`, immutable revocation, Commerce-owned aggregate reconciliation, receipt/audit/outbox in one transaction, and exact replay.
- [ ] Extend receipt/reconciliation reads to include Enrollment revocation and correction refs.
- [ ] Re-run the three suites and observe PASS.

## Chunk 4: Contract Mirrors and Honest Runtime

### Task 7: Regenerate Platform Commerce mirrors

**Files:**
- Regenerate: `src/interfaces/connect/generated-commerce/**`
- Regenerate: `src/interfaces/connect/generated-admin-commerce/**`
- Create: `scripts/contract/generate-commerce-fulfillment.mjs` with `--check` support and a pinned single-output Buf template for `fulfillment.proto`
- Modify: `src/modules/commerce/domain/canonical-fulfillment.ts`
- Modify: `src/modules/commerce/interfaces/connect/admin-commerce-service.ts`
- Modify: `src/process/admin.ts`
- Modify: `src/process/commerce-admin-composition.ts`
- Modify: `test/unit/canonical-fulfillment.test.ts`
- Modify: `test/unit/admin-commerce-catalog-connect.test.ts`
- Modify: `test/architecture/platform-api-deployable-parity.test.ts`

- [ ] Add failing tests that generated enums include enrollment, production code has no numeric enum casts, and the contract-only Admin Commerce provider is absent from runtime registration.
- [ ] Run the focused suites and observe stale mirror/provider failures.
- [ ] Run `corepack pnpm@11.2.2 --dir ../contract run buf:generate --boundary platform-admin-commerce@v1 --output "$PWD/src/interfaces/connect/generated-admin-commerce"`.
- [ ] Run `node scripts/contract/generate-commerce-fulfillment.mjs` to regenerate only `src/interfaces/connect/generated-commerce` from Root `fulfillment.proto`.
- [ ] Regenerate both Platform mirrors from current Root sources without editing Root or Web.
- [ ] Replace numeric casts with generated enum members and exhaustive switches.
- [ ] Remove stale legacy Admin Commerce runtime composition/registration; do not add price/payment/provider stubs.
- [ ] Re-run focused suites and observe PASS.

## Chunk 5: Final Verification and Commit

### Task 8: Verify and hand off

**Files:**
- Modify: `src/modules/commerce/INDEX.md`
- Modify: `src/modules/credit/INDEX.md`
- Modify: exact tests affected by the hard cut only

- [ ] Run `pnpm exec vitest run test/unit/preview-redemption.test.ts test/unit/commerce-redemption-repository.test.ts test/unit/commerce-administration.test.ts test/unit/credit-program-catalog.test.ts test/unit/commerce-schema.test.ts test/unit/credit-grant-issuer.test.ts test/unit/fulfillment-issuer.test.ts test/unit/credit-program-window.test.ts test/unit/credit-program-window-postgres.test.ts test/unit/credit-source-correction.test.ts test/unit/commerce-credit-enrollment-revocation.test.ts test/unit/confirm-redemption-postgres.test.ts test/unit/canonical-fulfillment.test.ts test/unit/admin-commerce-catalog-connect.test.ts test/architecture/module-imports.test.ts test/architecture/deployable-roles.test.ts test/architecture/platform-api-deployable-parity.test.ts test/security/platform-worker-database-authority.test.ts --no-cache`.
- [ ] Run `pnpm exec eslint $(git diff --name-only --diff-filter=ACMR 3998be3 -- '*.ts' '*.mts')`.
- [ ] Run `pnpm run typecheck:platform`.
- [ ] Run `node scripts/contract/generate-commerce-fulfillment.mjs --check`.
- [ ] Generate Admin Commerce into a temporary directory with `corepack pnpm@11.2.2 --dir ../contract run buf:generate --boundary platform-admin-commerce@v1 --output "$TMPDIR/kokoro-admin-commerce-check"` and run `diff -qr "$TMPDIR/kokoro-admin-commerce-check" src/interfaces/connect/generated-admin-commerce`.
- [ ] Run `node ../scripts/repository/check-generated-contracts.mjs --root ..`; if it fails only because the forbidden-to-edit Web mirror is stale, record the exact boundary/mirror failure as the Web handoff.
- [ ] Run `git diff --check` and `git status --short`.
- [ ] Run `git diff --name-only 3998be3 --` (not `3998be3..HEAD`) so committed and uncommitted Platform changes are both audited.
- [ ] Run `git -C .. status --short -- contract kokoro-web kokoro-session kokoro-agent` and `git -C ../kokoro-web status --short`; report pre-existing/concurrent sibling drift but do not modify it.
- [ ] Compare Platform `contract-metadata.ts` source digest to a fresh Root generation and compare the Web Admin Commerce metadata digest, producing exact Root/Web provider-consumer handoff facts.
- [ ] Commit Platform changes with a Commerce/Credit hard-cut message.
- [ ] Report Docker integration tests as not run, recurring/public worker and payment rails as feature-off, and exact Root/Web/provider/worker-RLS handoffs.
