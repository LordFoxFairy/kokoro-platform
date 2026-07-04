# kokoro-user Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-user` as the second subrepo after `kokoro-site`, with standard delete/restore lifecycle, deleted-aware owner checks, and a single-source admin contract.

**Architecture:** Extend the existing Prisma repository/service/HTTP layering. Business delete methods expose normal delete/restore names while persisting `deletedAt/deletedBy/deleteReason`; default reads exclude deleted rows and admin restore surfaces explicitly include them.

**Tech Stack:** Prisma, MySQL, Zod, Fastify, Vitest, `@kokoro/platform-kit` admin manifest schema.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-user` plus minimal shared/admin consumption files needed by user.
- Existing dirty `kokoro-user` changes must be read and preserved; do not revert them.
- Local dev DB data may be discarded with `db:reset`; business delete implementation must remain soft-delete.
- Do not introduce special public delete names. Use `delete*` / `restore*`.

## File Map

- Modify: `kokoro-user/prisma/schema.prisma`
  Add deletion audit fields and deleted-aware indexes.
- Create: `kokoro-user/prisma/migrations/<timestamp>_add_user_lifecycle_delete/migration.sql`
  SQL migration for nullable audit fields and indexes.
- Create: `kokoro-user/src/domain/user-deletion.ts`
  `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`, lifecycle errors.
- Modify: `kokoro-user/src/domain/{user,team,membership,service-account}.ts`
  Add deletion audit fields to returned domain shapes.
- Modify: `kokoro-user/src/domain/repository.ts`
  Add delete/restore/list options and owner-active contracts.
- Modify: `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts`
  Implement deleted-aware upsert/list/owner active/delete/restore.
- Modify: `kokoro-user/src/application/user-service.ts`
  Delegate lifecycle methods and keep business errors explicit.
- Modify: `kokoro-user/src/interfaces/http/schemas.ts`
  Add params/body schemas for delete/restore and owner active.
- Modify: `kokoro-user/src/interfaces/http/routes.ts`
  Add delete/restore routes and lifecycle error mapping.
- Create: `kokoro-user/src/interfaces/admin/user-admin-contract.ts`
  Single-source manifest/action contract.
- Modify: `kokoro-user/src/interfaces/admin/manifest.ts`
  Export contract-derived manifest.
- Modify: `kokoro-user/src/interfaces/http/admin-routes.ts`
  Include deleted rows where restore workflows need them.
- Tests:
  - `kokoro-user/test/integration/user-repository.test.ts`
  - `kokoro-user/test/integration/user-api.test.ts`
  - `kokoro-user/test/integration/user-admin.test.ts`
  - `kokoro-user/test/unit/user-admin-contract.test.ts`
  - `kokoro-user/test/unit/user-service.test.ts`

## Chunk 1: Repository Red Tests

### Task 1: User Delete/Restore Tests

**Files:**
- Modify: `kokoro-user/test/integration/user-repository.test.ts`

- [ ] Add failing test: deleting a user sets `deletedAt/deletedBy/deleteReason`, hides it from default `listUsers`, and makes `resolveOwnerActive({ ownerKind:"user" })` return false.
- [ ] Add failing test: ensuring a deleted `(siteId, externalUserId)` rejects with `user.deleted`.
- [ ] Add failing test: restoring the user clears deletion audit and makes owner active true again.
- [ ] Run:

```bash
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user exec vitest run test/integration/user-repository.test.ts --no-file-parallelism
```

Expected: fail on missing delete/restore/deleted fields.

### Task 2: Team And Membership Delete Tests

**Files:**
- Modify: `kokoro-user/test/integration/user-repository.test.ts`

- [ ] Add failing test: deleting a team hides team, memberships, and team service accounts from default read surfaces.
- [ ] Add failing test: `upsertTeam` rejects when owner user is deleted or cross-site.
- [ ] Add failing test: `setMembershipRole` rejects cross-site or deleted team/user and does not create membership.
- [ ] Run same repository integration command.

Expected: fail because repository does not yet handle deleted rows or site alignment.

## Chunk 2: DB Schema And Prisma Client

### Task 3: Add Schema Fields And Migration

**Files:**
- Modify: `kokoro-user/prisma/schema.prisma`
- Create: `kokoro-user/prisma/migrations/<timestamp>_add_user_lifecycle_delete/migration.sql`

- [ ] Add nullable `deletedAt`, `deletedBy`, `deleteReason` to `User`, `Team`, `Membership`, `Role`, `Invite`, `ServiceAccount`.
- [ ] Add indexes described in `docs/platform/tech/2026-07-03-kokoro-user-subrepo-hardening.md`.
- [ ] Keep `UserAuditLog` append-only; no delete fields.
- [ ] Run:

```bash
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user exec prisma format
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user db:generate
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user db:reset
```

Expected: migration applies from empty DB and Prisma client regenerates.

## Chunk 3: Repository Implementation

### Task 4: Domain Lifecycle Types

**Files:**
- Create: `kokoro-user/src/domain/user-deletion.ts`
- Modify: `kokoro-user/src/domain/{user,team,membership,service-account}.ts`
- Modify: `kokoro-user/src/domain/repository.ts`

- [ ] Add `DeletionAudit`, `DeleteInput`, `RestoreInput`, `ListOptions`.
- [ ] Add `UserLifecycleError` codes: `user.deleted`, `team.deleted`, `membership.deleted`, `service_account.deleted`, plus not-found variants.
- [ ] Add repository methods:

```ts
deleteUser(input: DeleteInput): Promise<User>;
restoreUser(input: RestoreInput): Promise<User>;
deleteTeam(input: DeleteInput): Promise<Team>;
restoreTeam(input: RestoreInput): Promise<Team>;
deleteServiceAccount(input: DeleteInput): Promise<ServiceAccount>;
listUsers(siteId?: string, options?: ListOptions): Promise<User[]>;
```

- [ ] Run `pnpm --filter @kokoro/user typecheck`.

Expected: may fail until repository implementation is complete.

### Task 5: Implement Repository Lifecycle

**Files:**
- Modify: `kokoro-user/src/infrastructure/prisma/prisma-user-repository.ts`

- [ ] Implement `visibleRows(options)` and `deletionData(input)` helpers.
- [ ] Make `ensureUserWithPersonalTeam` reject deleted `(siteId, externalUserId)`.
- [ ] Make `upsertTeam` validate owner user: same site, active, not deleted.
- [ ] Make `setMembershipRole` validate team/user: same site, active, not deleted.
- [ ] Make `resolveOwnerActive` require active + `deletedAt: null`.
- [ ] Make default `listUsers/listTeams/listMemberships/listServiceAccounts` exclude deleted.
- [ ] Implement `deleteUser/restoreUser`, including personal-team and membership/service-account visibility cascade.
- [ ] Implement `deleteTeam/restoreTeam`, including memberships/service accounts.
- [ ] Run repository integration command.

Expected: repository tests pass.

## Chunk 4: HTTP Contract

### Task 6: HTTP Red Tests

**Files:**
- Modify: `kokoro-user/test/integration/user-api.test.ts`

- [ ] Add failing test: `DELETE /users/:userId` hides user and owner active returns false.
- [ ] Add failing test: `POST /users/:userId/restore` restores owner active.
- [ ] Add failing test: `DELETE /teams/:teamId` hides team and owner active returns false.
- [ ] Add failing test: deleted owner cannot be used in `/teams/upsert`.
- [ ] Run:

```bash
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user exec vitest run test/integration/user-api.test.ts --no-file-parallelism
```

Expected: fail on missing routes/error handling.

### Task 7: Implement HTTP Routes

**Files:**
- Modify: `kokoro-user/src/interfaces/http/schemas.ts`
- Modify: `kokoro-user/src/interfaces/http/routes.ts`
- Modify: `kokoro-user/src/application/user-service.ts`

- [ ] Add `deleteRequestSchema`, `userParamsSchema`, `teamParamsSchema`, `serviceAccountParamsSchema`.
- [ ] Add routes:
  - `DELETE /users/:userId`
  - `POST /users/:userId/restore`
  - `DELETE /teams/:teamId`
  - `POST /teams/:teamId/restore`
  - `DELETE /service-accounts/:serviceAccountId` or remove the manifest action until implemented.
- [ ] Map lifecycle errors to 404/409 with stable codes.
- [ ] Run user API integration test.

Expected: HTTP tests pass.

## Chunk 5: Admin Contract

### Task 8: Contract Red Test

**Files:**
- Create: `kokoro-user/test/unit/user-admin-contract.test.ts`

- [ ] Assert `userAdminManifest` equals `userAdminContract.manifest`.
- [ ] Assert all action declarations have real routes or are intentionally absent.
- [ ] Assert users/teams have delete/restore actions; service account revoke has a route if present.
- [ ] Run:

```bash
pnpm --filter @kokoro/user exec vitest run test/unit/user-admin-contract.test.ts
```

Expected: fail because contract file does not exist and manifest still hand-written.

### Task 9: Implement Admin Contract

**Files:**
- Create: `kokoro-user/src/interfaces/admin/user-admin-contract.ts`
- Modify: `kokoro-user/src/interfaces/admin/manifest.ts`
- Modify: `kokoro-user/src/interfaces/http/admin-routes.ts`
- Modify if necessary: `kokoro-admin-web/components/shell/resource-table.tsx`

- [ ] Create contract with resources/actions/routes/method/kind/permissions.
- [ ] Derive `userAdminManifest` from contract.
- [ ] Make admin lists include deleted rows for restore workflows.
- [ ] Keep admin-web changes minimal; it already supports route param inference after site work.
- [ ] Run user admin unit/integration tests.

Expected: admin contract tests pass.

## Chunk 6: Gates And Commit

### Task 10: Full Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/user typecheck
pnpm --filter @kokoro/user test
env DATABASE_URL_USER=mysql://root:kokoro_root@127.0.0.1:3307/kokoro_user pnpm --filter @kokoro/user test:integration
pnpm --filter @kokoro/user lint
git diff --check
```

- [ ] If shared/admin-web files are touched, run their scoped checks too.
- [ ] Check source/test naming for special public delete names.

### Task 11: Scoped Commit

- [ ] Stage only `kokoro-user` lifecycle files, the user tech plan, and minimal shared/admin-web files if touched.
- [ ] Do not stage unrelated existing dirty changes in `payment/credit/model/platform-admin`.
- [ ] Commit:

```bash
git commit -m "feat(user): add lifecycle deletion contract"
```

Expected: one focused commit.
