# kokoro-model Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-model` with provider account and model binding lifecycle, deleted-aware model resolution, and a single-source admin contract.

**Architecture:** Keep model labels read-only and site policies state-based. Add delete/restore lifecycle only to `ProviderAccount` and `ModelBinding`; default business reads exclude deleted rows while admin restore workflows can include them. Preserve the existing Prisma repository, thin service, Fastify route, and manifest layering.

**Tech Stack:** Prisma, MySQL, Zod, Fastify, Vitest, `@kokoro/platform-kit` admin manifest schema.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-model` plus the model tech plan.
- Local dev DB data may be discarded with `db:reset`; business delete implementation must remain soft delete.
- Use normal `delete*` / `restore*` names.
- Keep `ModelLabel` read-only unless a real create/update/delete route is implemented later.
- Keep `SiteModelPolicy` on `visible/hidden` upsert semantics in this round.

## File Map

- Modify: `kokoro-model/prisma/schema.prisma`
  Add deletion audit fields and deleted-aware indexes for provider accounts and model bindings only.
- Create: `kokoro-model/prisma/migrations/<timestamp>_add_model_lifecycle_delete/migration.sql`
  SQL migration for nullable audit fields and indexes.
- Create: `kokoro-model/src/domain/model-lifecycle.ts`
  `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`, lifecycle errors.
- Modify: `kokoro-model/src/domain/model.ts`
  Add deletion audit fields to `ProviderAccount` and `ModelBinding`.
- Modify: `kokoro-model/src/domain/repository.ts`
  Add lifecycle methods and list options.
- Modify: `kokoro-model/src/infrastructure/prisma/prisma-model-repository.ts`
  Implement deleted-aware provider/binding behavior.
- Modify: `kokoro-model/src/application/model-service.ts`
  Delegate lifecycle methods.
- Modify: `kokoro-model/src/interfaces/http/schemas.ts`
  Add params/body schemas for provider and binding lifecycle.
- Modify: `kokoro-model/src/interfaces/http/routes.ts`
  Add public lifecycle routes and lifecycle error mapping.
- Create: `kokoro-model/src/interfaces/admin/model-admin-contract.ts`
  Single-source manifest/action/route contract.
- Modify: `kokoro-model/src/interfaces/admin/manifest.ts`
  Export contract-derived manifest.
- Modify: `kokoro-model/src/interfaces/http/admin-routes.ts`
  Include deleted provider/binding rows for restore workflows and add admin lifecycle routes.
- Tests:
  - `kokoro-model/test/integration/model-repository.test.ts`
  - `kokoro-model/test/integration/model-api.test.ts`
  - `kokoro-model/test/integration/model-admin.test.ts`
  - `kokoro-model/test/unit/model-service.test.ts`
  - `kokoro-model/test/unit/model-admin-contract.test.ts`
  - `kokoro-model/test/unit/model-schemas.test.ts`
  - `kokoro-model/test/unit/admin-manifest.test.ts`

## Chunk 1: Repository Red Tests

### Task 1: Provider Account Delete/Restore Tests

**Files:**
- Modify: `kokoro-model/test/integration/model-repository.test.ts`

- [ ] Add failing test: deleting a provider account sets `deletedAt/deletedBy/deleteReason`, hides it from default `listProviderAccounts`, and makes `resolveModelBindings` skip all bindings under it.
- [ ] Add failing test: `ensureProviderAccount` rejects a deleted `(provider,key)` with `model.provider_account.deleted`.
- [ ] Add failing test: restore clears deletion audit and makes default provider account lists include the row again.
- [ ] Run:

```bash
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model exec vitest run test/integration/model-repository.test.ts --no-file-parallelism
```

Expected: fail on missing lifecycle fields/methods.

### Task 2: Model Binding Delete/Restore Tests

**Files:**
- Modify: `kokoro-model/test/integration/model-repository.test.ts`

- [ ] Add failing test: deleting a model binding sets deletion audit, hides it from default `listAllModelBindings`, and removes it from `listModelBindings` and `resolveModelBindings`.
- [ ] Add failing test: `ensureModelBinding` rejects a deleted `(providerAccountId,modelName,transportKind)` with `model.binding.deleted`.
- [ ] Add failing test: restore clears deletion audit and makes the binding eligible again according to its existing status.
- [ ] Run the same repository integration command.

Expected: fail until repository lifecycle is implemented.

### Task 3: Service Boundary Tests

**Files:**
- Modify: `kokoro-model/test/unit/model-service.test.ts`

- [ ] Add failing tests that `deleteProviderAccount`, `restoreProviderAccount`, `deleteModelBinding`, and `restoreModelBinding` delegate to repository with exact inputs.
- [ ] Add list option forwarding tests for `listProviderAccounts({ includeDeleted: true })` and `listAllModelBindings({ includeDeleted: true })` if these service methods are exposed.
- [ ] Run:

```bash
pnpm --filter @kokoro/model exec vitest run test/unit/model-service.test.ts
```

Expected: fail until service/repository interfaces include lifecycle methods.

## Chunk 2: DB Schema And Prisma Client

### Task 4: Add Schema Fields And Migration

**Files:**
- Modify: `kokoro-model/prisma/schema.prisma`
- Create: `kokoro-model/prisma/migrations/<timestamp>_add_model_lifecycle_delete/migration.sql`

- [ ] Add nullable `deletedAt`, `deletedBy`, `deleteReason` to `ProviderAccount`.
- [ ] Add nullable `deletedAt`, `deletedBy`, `deleteReason` to `ModelBinding`.
- [ ] Add indexes described in `docs/platform/tech/2026-07-06-kokoro-model-subrepo-hardening.md`.
- [ ] Keep `ModelLabel` and `SiteModelPolicy` without delete fields.
- [ ] Run:

```bash
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model exec prisma format
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model db:generate
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model db:reset
```

Expected: migration applies from empty DB and Prisma client regenerates under `kokoro-model/generated/prisma`.

## Chunk 3: Repository And Service Implementation

### Task 5: Domain Lifecycle Types

**Files:**
- Create: `kokoro-model/src/domain/model-lifecycle.ts`
- Modify: `kokoro-model/src/domain/model.ts`
- Modify: `kokoro-model/src/domain/repository.ts`

- [ ] Add `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`.
- [ ] Add lifecycle errors:
  - `model.provider_account.not_found`
  - `model.provider_account.deleted`
  - `model.binding.not_found`
  - `model.binding.deleted`
- [ ] Add repository methods:

```ts
deleteProviderAccount(input: DeleteInput): Promise<ProviderAccount>;
restoreProviderAccount(input: RestoreInput): Promise<ProviderAccount>;
deleteModelBinding(input: DeleteInput): Promise<ModelBinding>;
restoreModelBinding(input: RestoreInput): Promise<ModelBinding>;
listProviderAccounts(options?: ListOptions): Promise<ProviderAccount[]>;
listAllModelBindings(options?: ListOptions): Promise<ModelBinding[]>;
```

- [ ] Run:

```bash
pnpm --filter @kokoro/model typecheck
```

Expected: may fail until repository/service implementation is complete.

### Task 6: Implement Repository Lifecycle

**Files:**
- Modify: `kokoro-model/src/infrastructure/prisma/prisma-model-repository.ts`

- [ ] Implement `visibleRows(options)`, `deletionData(input)`, and `restoreData()`.
- [ ] Make `ensureProviderAccount` reject a deleted `(provider,key)`.
- [ ] Make `ensureModelBinding` reject deleted provider accounts and deleted unique binding rows.
- [ ] Make default `listProviderAccounts`, `listAllModelBindings`, and `listModelBindings` exclude deleted rows.
- [ ] Make `resolveModelBindings` require binding `deletedAt=null` and provider account `deletedAt=null`.
- [ ] Implement `deleteProviderAccount/restoreProviderAccount`.
- [ ] Implement `deleteModelBinding/restoreModelBinding`.
- [ ] Run repository integration command.

Expected: repository lifecycle tests pass.

### Task 7: Implement Service Boundary

**Files:**
- Modify: `kokoro-model/src/application/model-service.ts`

- [ ] Add service methods for provider account delete/restore.
- [ ] Add service methods for model binding delete/restore.
- [ ] Expose list methods with `ListOptions` where admin needs includeDeleted.
- [ ] Run service unit test.

Expected: service tests pass.

## Chunk 4: HTTP Contract

### Task 8: HTTP Red Tests

**Files:**
- Modify: `kokoro-model/test/integration/model-api.test.ts`
- Modify: `kokoro-model/test/unit/model-schemas.test.ts`

- [ ] Add failing schema tests for `providerAccountParamsSchema`, `modelBindingParamsSchema`, and `deleteRequestSchema`.
- [ ] Add failing API test: `DELETE /provider-accounts/:providerAccountId` hides its bindings from resolve and makes ensure reject the same `(provider,key)`.
- [ ] Add failing API test: `POST /provider-accounts/:providerAccountId/restore` restores resolve eligibility.
- [ ] Add failing API test: `DELETE /model-bindings/:modelBindingId` hides only that binding from list/resolve.
- [ ] Add failing API test: `POST /model-bindings/:modelBindingId/restore` restores binding eligibility.
- [ ] Run:

```bash
pnpm --filter @kokoro/model exec vitest run test/unit/model-schemas.test.ts
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model exec vitest run test/integration/model-api.test.ts --no-file-parallelism
```

Expected: fail on missing schemas/routes.

### Task 9: Implement HTTP Routes

**Files:**
- Modify: `kokoro-model/src/interfaces/http/schemas.ts`
- Modify: `kokoro-model/src/interfaces/http/routes.ts`

- [ ] Add params schemas:
  - `providerAccountParamsSchema`
  - `modelBindingParamsSchema`
- [ ] Add `deleteRequestSchema` with required `deletedBy` and optional `reason`.
- [ ] Add routes:
  - `DELETE /provider-accounts/:providerAccountId`
  - `POST /provider-accounts/:providerAccountId/restore`
  - `DELETE /model-bindings/:modelBindingId`
  - `POST /model-bindings/:modelBindingId/restore`
- [ ] Map lifecycle errors to 404/409 with stable codes.
- [ ] Run model API integration test.

Expected: HTTP tests pass.

## Chunk 5: Admin Contract

### Task 10: Contract Red Test

**Files:**
- Create: `kokoro-model/test/unit/model-admin-contract.test.ts`
- Modify: `kokoro-model/test/unit/admin-manifest.test.ts`

- [ ] Assert `modelAdminManifest` equals `modelAdminContract.manifest`.
- [ ] Assert every mutation/dangerMutation action declaration has a real route/method entry.
- [ ] Assert provider actions expose `create`, `delete`, `restore`, `disable`, `enable`.
- [ ] Assert binding actions expose `create`, `delete`, `restore`, `disable`, `enable`.
- [ ] Assert model labels expose no fake write actions.
- [ ] Run:

```bash
pnpm --filter @kokoro/model exec vitest run test/unit/model-admin-contract.test.ts test/unit/admin-manifest.test.ts
```

Expected: fail because contract file does not exist and manifest is hand-written.

### Task 11: Implement Admin Contract And Routes

**Files:**
- Create: `kokoro-model/src/interfaces/admin/model-admin-contract.ts`
- Modify: `kokoro-model/src/interfaces/admin/manifest.ts`
- Modify: `kokoro-model/src/interfaces/http/admin-routes.ts`
- Modify: `kokoro-model/test/integration/model-admin.test.ts`

- [ ] Create contract with resources/actions/routes/method/kind/permissions.
- [ ] Derive `modelAdminManifest` from contract.
- [ ] Keep `model-labels` action list empty.
- [ ] Make admin provider account list include deleted rows for restore workflows.
- [ ] Make admin binding list include deleted rows for restore workflows.
- [ ] Add admin routes:
  - `DELETE /admin/models/provider-accounts/:providerAccountId`
  - `POST /admin/models/provider-accounts/:providerAccountId/restore`
  - `DELETE /admin/models/bindings/:modelBindingId`
  - `POST /admin/models/bindings/:modelBindingId/restore`
- [ ] Keep existing enable/disable routes and permissions.
- [ ] Run model admin unit/integration tests.

Expected: admin contract and admin integration tests pass.

## Chunk 6: Gates And Commit

### Task 12: Full Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/model typecheck
pnpm --filter @kokoro/model test
env DATABASE_URL_MODEL=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_model pnpm --filter @kokoro/model test:integration
pnpm --filter @kokoro/model lint
git diff --check
```

- [ ] If shared files are touched, run their scoped checks too.
- [ ] Check source/test/docs naming for special public delete aliases. Public API and code should use ordinary `delete` / `restore` names only.

Expected: all gates pass and the naming scan returns no matches.

### Task 13: Scoped Commit

**Files:**
- Stage only `kokoro-model` implementation files and generated Prisma client/migration files needed by model.

- [ ] Inspect status:

```bash
git status --short
```

- [ ] Stage model implementation only:

```bash
git add kokoro-model
```

- [ ] Inspect staged files:

```bash
git diff --cached --name-only
```

- [ ] Commit:

```bash
git commit -m "feat(model): add lifecycle deletion contract"
```

Expected: commit contains model implementation only. Existing unrelated dirty files remain unstaged.
