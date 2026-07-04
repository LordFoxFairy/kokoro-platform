# kokoro-credit Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-credit` after `kokoro-site` and `kokoro-user`, with account/pricing lifecycle, deleted-aware credit mutations, owner/site active enforcement, and a single-source admin contract.

**Architecture:** Keep ledger and usage append-only. Add delete/restore lifecycle only to `CreditAccount` and `PricingRule`; default business reads exclude deleted rows while admin restore surfaces explicitly include them. Preserve existing Prisma repository/service/HTTP layering and the cross-service owner/site checker.

**Tech Stack:** Prisma, MySQL, Zod, Fastify, Vitest, `@kokoro/platform-kit` admin manifest schema.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-credit` plus minimal shared files if required.
- Existing dirty `kokoro-credit` owner/site checker work must be preserved and收束; do not revert it.
- Local dev DB data may be discarded with `db:reset`; business delete implementation must remain soft-delete.
- Use normal `delete*` / `restore*` names.

## File Map

- Modify: `kokoro-credit/prisma/schema.prisma`
  Add deletion audit fields and deleted-aware indexes for account/pricing only.
- Create: `kokoro-credit/prisma/migrations/<timestamp>_add_credit_lifecycle_delete/migration.sql`
  SQL migration for nullable audit fields and indexes.
- Create: `kokoro-credit/src/domain/credit-lifecycle.ts`
  `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`, lifecycle errors.
- Modify: `kokoro-credit/src/domain/credit.ts`
  Add deletion audit fields to `CreditAccount` and `PricingRule`.
- Modify: `kokoro-credit/src/domain/repository.ts`
  Add lifecycle methods, list options, and pricing create contract.
- Modify: `kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts`
  Implement deleted-aware account/pricing behavior.
- Modify: `kokoro-credit/src/application/credit-service.ts`
  Ensure account/site/owner active boundaries are explicit and lifecycle methods delegate.
- Modify: `kokoro-credit/src/infrastructure/http/owner-site-checker.ts`
  Keep fail-closed cross-service checker and align tests.
- Modify: `kokoro-credit/src/interfaces/http/schemas.ts`
  Add params/body schemas for account/pricing lifecycle.
- Modify: `kokoro-credit/src/interfaces/http/routes.ts`
  Add delete/restore/create pricing routes and lifecycle error mapping.
- Create: `kokoro-credit/src/interfaces/admin/credit-admin-contract.ts`
  Single-source manifest/action contract.
- Modify: `kokoro-credit/src/interfaces/admin/manifest.ts`
  Export contract-derived manifest.
- Modify: `kokoro-credit/src/interfaces/http/admin-routes.ts`
  Include deleted rows where restore workflows need them and add admin pricing action routes if needed.
- Tests:
  - `kokoro-credit/test/integration/credit-repository.test.ts`
  - `kokoro-credit/test/integration/credit-api.test.ts`
  - `kokoro-credit/test/integration/credit-admin.test.ts`
  - `kokoro-credit/test/integration/credit-quote.test.ts`
  - `kokoro-credit/test/unit/credit-service.test.ts`
  - `kokoro-credit/test/unit/credit-admin-contract.test.ts`
  - `kokoro-credit/test/unit/credit-schemas.test.ts`
  - `kokoro-credit/test/unit/owner-site-checker.test.ts`

## Chunk 1: Repository Red Tests

### Task 1: Account Delete/Restore Tests

**Files:**
- Modify: `kokoro-credit/test/integration/credit-repository.test.ts`

- [ ] Add failing test: deleting an account sets `deletedAt/deletedBy/deleteReason`, hides it from default `listAccounts`, and keeps ledger/usage accessible.
- [ ] Add failing test: `ensureAccount` rejects a deleted `(siteId, ownerKind, ownerId)` with `credit.account.deleted`.
- [ ] Add failing test: restore clears deletion audit and makes default lists include the account again.
- [ ] Add failing test: deleting an account with active holds rejects with `credit.account.active_hold_exists`.
- [ ] Run:

```bash
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit exec vitest run test/integration/credit-repository.test.ts --no-file-parallelism
```

Expected: fail on missing lifecycle methods/fields.

### Task 2: Pricing Rule Delete/Restore Tests

**Files:**
- Modify: `kokoro-credit/test/integration/credit-quote.test.ts`

- [ ] Add failing test: quote skips deleted pricing rules and falls back to generic rule.
- [ ] Add failing test: restore makes the pricing rule eligible again.
- [ ] Add failing test: deleted-only pricing rules produce `PricingRuleNotFoundError`.
- [ ] Run:

```bash
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit exec vitest run test/integration/credit-quote.test.ts --no-file-parallelism
```

Expected: fail because pricing rules do not yet have deletion fields.

## Chunk 2: DB Schema And Prisma Client

### Task 3: Add Schema Fields And Migration

**Files:**
- Modify: `kokoro-credit/prisma/schema.prisma`
- Create: `kokoro-credit/prisma/migrations/<timestamp>_add_credit_lifecycle_delete/migration.sql`

- [ ] Add nullable `deletedAt`, `deletedBy`, `deleteReason` to `CreditAccount` and `PricingRule`.
- [ ] Add indexes described in `docs/platform/tech/2026-07-04-kokoro-credit-subrepo-hardening.md`.
- [ ] Keep `CreditLedgerEntry`, `UsageRecord`, and `CreditHold` without delete fields.
- [ ] Run:

```bash
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit exec prisma format
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit db:generate
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit db:reset
```

Expected: migration applies from empty DB and Prisma client regenerates under `kokoro-credit/generated/prisma`.

## Chunk 3: Repository And Service Implementation

### Task 4: Domain Lifecycle Types

**Files:**
- Create: `kokoro-credit/src/domain/credit-lifecycle.ts`
- Modify: `kokoro-credit/src/domain/credit.ts`
- Modify: `kokoro-credit/src/domain/repository.ts`

- [ ] Add `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`.
- [ ] Add lifecycle errors: `credit.account.deleted`, `credit.account.active_hold_exists`, `credit.pricing_rule.deleted`, plus not-found variants.
- [ ] Add repository methods:

```ts
deleteAccount(input: DeleteInput): Promise<CreditAccount>;
restoreAccount(input: RestoreInput): Promise<CreditAccount>;
createPricingRule(input: CreatePricingRuleInput): Promise<PricingRule>;
deletePricingRule(input: DeleteInput): Promise<PricingRule>;
restorePricingRule(input: RestoreInput): Promise<PricingRule>;
listAccounts(siteId?: string, options?: ListOptions): Promise<CreditAccount[]>;
listPricingRules(options?: ListOptions): Promise<PricingRule[]>;
```

- [ ] Run `pnpm --filter @kokoro/credit typecheck`.

Expected: may fail until repository/service implementation is complete.

### Task 5: Implement Repository Lifecycle

**Files:**
- Modify: `kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts`

- [ ] Implement `visibleRows(options)`, `deletionData(input)`, and `restoreData()`.
- [ ] Make `ensureAccount` reject deleted owner account keys.
- [ ] Make `getAccountById` default to deleted-aware behavior for mutation pre-checks.
- [ ] Make grant/spend/hold fail on deleted accounts.
- [ ] Make default `listAccounts/listPricingRules` exclude deleted.
- [ ] Implement `deleteAccount/restoreAccount`, with active hold guard.
- [ ] Implement `createPricingRule/deletePricingRule/restorePricingRule`.
- [ ] Make `quote` require `deletedAt: null`.
- [ ] Run repository and quote integration commands.

Expected: repository and quote tests pass.

### Task 6: Service Boundary Tests And Implementation

**Files:**
- Modify: `kokoro-credit/test/unit/credit-service.test.ts`
- Modify: `kokoro-credit/src/application/credit-service.ts`

- [ ] Add failing tests that grant/spend/hold reject deleted accounts before repository mutation.
- [ ] Add failing tests that `ensureAccount` uses owner/site active checker for new accounts.
- [ ] Add service delegation tests for account/pricing lifecycle methods.
- [ ] Implement minimal service methods and lifecycle error mapping.
- [ ] Run:

```bash
pnpm --filter @kokoro/credit exec vitest run test/unit/credit-service.test.ts
```

Expected: service tests pass.

## Chunk 4: HTTP Contract

### Task 7: HTTP Red Tests

**Files:**
- Modify: `kokoro-credit/test/integration/credit-api.test.ts`

- [ ] Add failing test: `DELETE /credit/accounts/:accountId` hides account and future grant/spend/hold reject.
- [ ] Add failing test: `POST /credit/accounts/:accountId/restore` restores mutation eligibility.
- [ ] Add failing test: `POST /credit/pricing-rules` creates a quoteable rule.
- [ ] Add failing test: `DELETE /credit/pricing-rules/:pricingRuleId` makes quote skip it.
- [ ] Run:

```bash
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit exec vitest run test/integration/credit-api.test.ts --no-file-parallelism
```

Expected: fail on missing routes/error handling.

### Task 8: Implement HTTP Routes

**Files:**
- Modify: `kokoro-credit/src/interfaces/http/schemas.ts`
- Modify: `kokoro-credit/src/interfaces/http/routes.ts`

- [ ] Add `deleteRequestSchema`, `accountParamsSchema`, `pricingRuleParamsSchema`, `createPricingRuleRequestSchema`.
- [ ] Add routes:
  - `DELETE /credit/accounts/:accountId`
  - `POST /credit/accounts/:accountId/restore`
  - `POST /credit/pricing-rules`
  - `DELETE /credit/pricing-rules/:pricingRuleId`
  - `POST /credit/pricing-rules/:pricingRuleId/restore`
- [ ] Map lifecycle errors to 404/409 with stable codes.
- [ ] Run credit API integration test.

Expected: HTTP tests pass.

## Chunk 5: Admin Contract

### Task 9: Contract Red Test

**Files:**
- Create: `kokoro-credit/test/unit/credit-admin-contract.test.ts`

- [ ] Assert `creditAdminManifest` equals `creditAdminContract.manifest`.
- [ ] Assert all mutation action declarations have real route/method entries.
- [ ] Assert account and pricing resources expose delete/restore actions.
- [ ] Run:

```bash
pnpm --filter @kokoro/credit exec vitest run test/unit/credit-admin-contract.test.ts
```

Expected: fail because contract file does not exist and manifest is hand-written.

### Task 10: Implement Admin Contract

**Files:**
- Create: `kokoro-credit/src/interfaces/admin/credit-admin-contract.ts`
- Modify: `kokoro-credit/src/interfaces/admin/manifest.ts`
- Modify: `kokoro-credit/src/interfaces/http/admin-routes.ts`
- Modify: `kokoro-credit/test/integration/credit-admin.test.ts`

- [ ] Create contract with resources/actions/routes/method/kind/permissions.
- [ ] Derive `creditAdminManifest` from contract.
- [ ] Make admin account/pricing lists include deleted rows for restore workflows.
- [ ] Keep ledger and usage read-only.
- [ ] Run user admin unit/integration tests.

Expected: admin contract and admin integration tests pass.

## Chunk 6: Gates And Commit

### Task 11: Full Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/credit typecheck
pnpm --filter @kokoro/credit test
env DATABASE_URL_CREDIT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_credit pnpm --filter @kokoro/credit test:integration
pnpm --filter @kokoro/credit lint
git diff --check
```

- [ ] If shared files are touched, run their scoped checks too.
- [ ] Check source/test naming for special public delete names.

Expected: all gates pass.

### Task 12: Scoped Commit

- [ ] Stage only `kokoro-credit` lifecycle files, the credit tech plan, and minimal shared files if touched.
- [ ] Do not stage unrelated existing dirty changes in `payment/model/platform-admin/admin-web`.
- [ ] Commit:

```bash
git commit -m "feat(credit): add lifecycle deletion contract"
```

Expected: one focused commit.
