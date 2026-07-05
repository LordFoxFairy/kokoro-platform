# kokoro-payment Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-payment` after `kokoro-credit`, with plan lifecycle, deleted-aware payment operations, anchored order pricing, and a single-source admin contract.

**Architecture:** Keep payment facts append-only. Add delete/restore lifecycle only to `Plan`; default business reads exclude deleted rows while admin restore surfaces explicitly include them. Preserve existing Prisma repository/service/HTTP layering and the payment-to-credit grant/reverse client boundary.

**Tech Stack:** Prisma, MySQL, Zod, Fastify, Vitest, `@kokoro/platform-kit` admin manifest schema.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-payment` plus the payment tech plan.
- Existing dirty payment work must be preserved and收束:
  - `createOrder` already anchors amount/currency to plan.
  - `refundOrder` already uses reverse-first saga.
  - manifest already started adding plan upsert.
- Local dev DB data may be discarded with `db:reset`; business delete implementation must remain soft delete.
- Use normal `delete*` / `restore*` names.

## File Map

- Modify: `kokoro-payment/prisma/schema.prisma`
  Add deletion audit fields and deleted-aware indexes for plan only.
- Create: `kokoro-payment/prisma/migrations/<timestamp>_add_plan_lifecycle_delete/migration.sql`
  SQL migration for nullable audit fields and indexes.
- Create: `kokoro-payment/src/domain/payment-lifecycle.ts`
  `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`, lifecycle errors.
- Modify: `kokoro-payment/src/domain/payment.ts`
  Add deletion audit fields to `Plan`.
- Modify: `kokoro-payment/src/domain/repository.ts`
  Add lifecycle methods and list options.
- Modify: `kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts`
  Implement deleted-aware plan behavior.
- Modify: `kokoro-payment/src/application/payment-service.ts`
  Guard plan lifecycle in upsert/create/grant/confirm and delegate delete/restore.
- Modify: `kokoro-payment/src/interfaces/http/schemas.ts`
  Add params/body schemas for plan lifecycle.
- Modify: `kokoro-payment/src/interfaces/http/routes.ts`
  Add delete/restore plan routes and lifecycle error mapping.
- Create: `kokoro-payment/src/interfaces/admin/payment-admin-contract.ts`
  Single-source manifest/action contract.
- Modify: `kokoro-payment/src/interfaces/admin/manifest.ts`
  Export contract-derived manifest.
- Modify: `kokoro-payment/src/interfaces/http/admin-routes.ts`
  Include deleted plans for restore workflows and add admin plan lifecycle routes.
- Tests:
  - `kokoro-payment/test/integration/payment-repository.test.ts`
  - `kokoro-payment/test/integration/payment-api.test.ts`
  - `kokoro-payment/test/integration/payment-admin.test.ts`
  - `kokoro-payment/test/unit/payment-service.test.ts`
  - `kokoro-payment/test/unit/payment-admin-contract.test.ts`
  - `kokoro-payment/test/unit/payment-schemas.test.ts`
  - `kokoro-payment/test/unit/admin-manifest.test.ts`

## Chunk 1: Repository Red Tests

### Task 1: Plan Delete/Restore Tests

**Files:**
- Modify: `kokoro-payment/test/integration/payment-repository.test.ts`

- [ ] Add failing test: deleting a plan sets `deletedAt/deletedBy/deleteReason`, hides it from default `listPlans`, and leaves historical orders intact.
- [ ] Add failing test: `upsertPlan` rejects a deleted `(siteId,key)` with `payment.plan.deleted`.
- [ ] Add failing test: restore clears deletion audit and makes default lists include the plan again.
- [ ] Run:

```bash
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment exec vitest run test/integration/payment-repository.test.ts --no-file-parallelism
```

Expected: fail on missing lifecycle methods/fields.

### Task 2: Service Boundary Tests

**Files:**
- Modify: `kokoro-payment/test/unit/payment-service.test.ts`

- [ ] Add failing tests that `createOrder` rejects deleted/disabled plans before `createOrder`.
- [ ] Add failing test that `grantPlanToTeam` rejects a plan from another site.
- [ ] Add service delegation tests for `deletePlan` and `restorePlan`.
- [ ] Run:

```bash
pnpm --filter @kokoro/payment exec vitest run test/unit/payment-service.test.ts
```

Expected: fail until lifecycle methods and deleted-aware guards exist.

## Chunk 2: DB Schema And Prisma Client

### Task 3: Add Schema Fields And Migration

**Files:**
- Modify: `kokoro-payment/prisma/schema.prisma`
- Create: `kokoro-payment/prisma/migrations/<timestamp>_add_plan_lifecycle_delete/migration.sql`

- [ ] Add nullable `deletedAt`, `deletedBy`, `deleteReason` to `Plan`.
- [ ] Add indexes described in `docs/platform/tech/2026-07-05-kokoro-payment-subrepo-hardening.md`.
- [ ] Keep `Order`, `Subscription`, `PaymentEvent`, and `Refund` without delete fields.
- [ ] Run:

```bash
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment exec prisma format
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment db:generate
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment db:reset
```

Expected: migration applies from empty DB and Prisma client regenerates under `kokoro-payment/generated/prisma`.

## Chunk 3: Repository And Service Implementation

### Task 4: Domain Lifecycle Types

**Files:**
- Create: `kokoro-payment/src/domain/payment-lifecycle.ts`
- Modify: `kokoro-payment/src/domain/payment.ts`
- Modify: `kokoro-payment/src/domain/repository.ts`

- [ ] Add `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`.
- [ ] Add lifecycle errors: `payment.plan.deleted`, `payment.plan.not_found`.
- [ ] Add repository methods:

```ts
deletePlan(input: DeleteInput): Promise<Plan>;
restorePlan(input: RestoreInput): Promise<Plan>;
listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;
```

- [ ] Run `pnpm --filter @kokoro/payment typecheck`.

Expected: may fail until repository/service implementation is complete.

### Task 5: Implement Repository Lifecycle

**Files:**
- Modify: `kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts`

- [ ] Implement `visibleRows(options)`, `deletionData(input)`, and `restoreData()`.
- [ ] Make `upsertPlan` reject deleted `(siteId,key)`.
- [ ] Make default `listPlans` exclude deleted.
- [ ] Implement `deletePlan/restorePlan`.
- [ ] Make `findPlanById` return deleted plans so service can map deleted to a stable lifecycle error.
- [ ] Keep order/event/refund/subscription list behavior unchanged.
- [ ] Run repository integration command.

Expected: repository lifecycle tests pass.

### Task 6: Implement Service Boundary

**Files:**
- Modify: `kokoro-payment/src/application/payment-service.ts`

- [ ] Add `assertPlanSellable(plan, planId)` guard.
- [ ] Make `createOrder` reject deleted/disabled plans.
- [ ] Make `grantPlanToTeam` require plan site match and sellable plan.
- [ ] Make `confirmOrder` reject deleted plan before credit grant.
- [ ] Add `deletePlan/restorePlan` delegation.
- [ ] Run service unit test.

Expected: service tests pass.

## Chunk 4: HTTP Contract

### Task 7: HTTP Red Tests

**Files:**
- Modify: `kokoro-payment/test/integration/payment-api.test.ts`
- Modify: `kokoro-payment/test/unit/payment-schemas.test.ts`

- [ ] Add failing schema tests for `planParamsSchema` and `deleteRequestSchema`.
- [ ] Add failing API test: `DELETE /plans/:planId` hides plan and future createOrder rejects.
- [ ] Add failing API test: `POST /plans/:planId/restore` restores order eligibility.
- [ ] Run:

```bash
pnpm --filter @kokoro/payment exec vitest run test/unit/payment-schemas.test.ts
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment exec vitest run test/integration/payment-api.test.ts --no-file-parallelism
```

Expected: fail on missing schemas/routes.

### Task 8: Implement HTTP Routes

**Files:**
- Modify: `kokoro-payment/src/interfaces/http/schemas.ts`
- Modify: `kokoro-payment/src/interfaces/http/routes.ts`

- [ ] Add `planParamsSchema` and `deleteRequestSchema`.
- [ ] Add routes:
  - `DELETE /plans/:planId`
  - `POST /plans/:planId/restore`
- [ ] Map lifecycle errors to 404/409 with stable codes.
- [ ] Run payment API integration test.

Expected: HTTP tests pass.

## Chunk 5: Admin Contract

### Task 9: Contract Red Test

**Files:**
- Create: `kokoro-payment/test/unit/payment-admin-contract.test.ts`

- [ ] Assert `paymentAdminManifest` equals `paymentAdminContract.manifest`.
- [ ] Assert all mutation/dangerMutation action declarations have real route/method entries.
- [ ] Assert plan actions expose `upsert`, `delete`, `restore`, `grant-to-team`.
- [ ] Assert no `publish` or `approve` fake actions remain.
- [ ] Run:

```bash
pnpm --filter @kokoro/payment exec vitest run test/unit/payment-admin-contract.test.ts
```

Expected: fail because contract file does not exist and manifest is hand-written.

### Task 10: Implement Admin Contract

**Files:**
- Create: `kokoro-payment/src/interfaces/admin/payment-admin-contract.ts`
- Modify: `kokoro-payment/src/interfaces/admin/manifest.ts`
- Modify: `kokoro-payment/src/interfaces/http/admin-routes.ts`
- Modify: `kokoro-payment/test/integration/payment-admin.test.ts`

- [ ] Create contract with resources/actions/routes/method/kind/permissions.
- [ ] Derive `paymentAdminManifest` from contract.
- [ ] Remove fake actions: `plans.publish`, `refunds.approve`.
- [ ] Make admin plan list include deleted rows for restore workflows.
- [ ] Add admin plan delete/restore routes.
- [ ] Keep order/event/refund/subscription read-only except existing grant/refund actions.
- [ ] Run payment admin unit/integration tests.

Expected: admin contract and admin integration tests pass.

## Chunk 6: Gates And Commit

### Task 11: Full Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/payment typecheck
pnpm --filter @kokoro/payment test
env DATABASE_URL_PAYMENT=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_payment pnpm --filter @kokoro/payment test:integration
pnpm --filter @kokoro/payment lint
git diff --check
```

- [ ] If shared files are touched, run their scoped checks too.
- [ ] Check source/test naming for special public delete names.

Expected: all gates pass.

### Task 12: Scoped Commit

- [ ] Stage only `kokoro-payment` lifecycle files, the payment tech plan, and this plan.
- [ ] Do not stage unrelated existing dirty changes in `model/platform-admin/platform-kit/admin-web`.
- [ ] Commit:

```bash
git commit -m "feat(payment): add plan lifecycle contract"
```

Expected: one focused commit.
