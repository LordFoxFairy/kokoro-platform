# kokoro-site Soft Delete Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `kokoro-site` as the first hardened platform subrepo with explicit soft-delete semantics, lifecycle-safe lookup, and single-source admin contract.

**Architecture:** Keep `kokoro-site` as the owner of tenant/root site semantics. Soft deletion is represented in DB fields and enforced in repository defaults; HTTP/admin routes expose delete/restore as audited actions through the existing gateway. Admin contract starts local to `kokoro-site` and is only generalized after a second subrepo needs the same pattern.

**Tech Stack:** Prisma, Fastify, Zod, Vitest, Ant Design Pro consumer compatibility.

---

Spec: `docs/platform/tech/2026-07-02-kokoro-site-subrepo-hardening.md`

## Chunk 1: DB And Repository Soft Delete

### Task 1: Repository Red Test

**Files:**
- Modify: `kokoro-site/test/integration/site-repository.integration.test.ts`

- [ ] Add failing tests for soft-deleting and restoring `Site`.
- [ ] Add failing tests for soft-deleting `SiteDomain` and blocking context resolution.
- [ ] Run `pnpm --filter @kokoro/site test:integration -- --runInBand` or nearest existing integration command.
- [ ] Confirm failures are due to missing `delete*` / `restore*` behavior or missing `deletedAt` fields.

### Task 2: DB Schema And Prisma Client

**Files:**
- Modify: `kokoro-site/prisma/schema.prisma`
- Generated: `kokoro-site/generated/prisma/*`

- [ ] Add `deletedAt`, `deletedBy`, `deleteReason` fields to site tables.
- [ ] Add deleted-aware indexes with design reasons preserved in the tech spec.
- [ ] Run `pnpm --filter @kokoro/site db:generate`.

### Task 3: Repository Implementation

**Files:**
- Modify: `kokoro-site/src/domain/repository.ts`
- Modify: `kokoro-site/src/infrastructure/prisma/prisma-site-repository.ts`

- [ ] Add delete/restore input types and repository methods.
- [ ] Add default `deletedAt: null` filters to list and resolve paths.
- [ ] Make `resolveSiteActive` require `deletedAt === null` and `status === "active"`.
- [ ] Re-run `pnpm --filter @kokoro/site test:integration`.

## Chunk 2: HTTP Routes

### Task 4: HTTP Red Test

**Files:**
- Modify: `kokoro-site/test/integration/site-http.test.ts`

- [ ] Add failing tests for `POST /sites/:id/delete`, `POST /sites/:id/restore`, `POST /site-domains/:id/delete`, and `POST /site-domains/:id/restore`.
- [ ] Verify missing routes or missing behavior fail as expected.

### Task 5: HTTP Implementation

**Files:**
- Modify: `kokoro-site/src/interfaces/http/schemas.ts`
- Modify: `kokoro-site/src/application/site-service.ts`
- Modify: `kokoro-site/src/interfaces/http/routes.ts`

- [ ] Add strict delete/restore request schemas.
- [ ] Add service methods for delete/restore.
- [ ] Add Fastify routes and typed error envelopes.
- [ ] Re-run `pnpm --filter @kokoro/site test:integration`.

## Chunk 3: Site Admin Contract

### Task 6: Admin Contract Red Test

**Files:**
- Create: `kokoro-site/test/unit/site-admin-contract.test.ts`

- [ ] Add failing tests proving site manifest is derived from contract and every action has route/schema/permission.
- [ ] Add danger action tests requiring reason.
- [ ] Run `pnpm --filter @kokoro/site test`.

### Task 7: Admin Contract Implementation

**Files:**
- Create: `kokoro-site/src/interfaces/admin/site-admin-contract.ts`
- Modify: `kokoro-site/src/interfaces/admin/manifest.ts`
- Modify: `kokoro-site/src/interfaces/http/admin-routes.ts`
- Modify if necessary: `kokoro-platform-kit/src/admin/manifest-schema.ts`

- [ ] Define local site admin contract with form/action metadata.
- [ ] Derive `siteAdminManifest` from the contract.
- [ ] Keep backward-compatible manifest fields for the current gateway/admin-web.
- [ ] Re-run `pnpm --filter @kokoro/site test` and `pnpm --filter @kokoro/site typecheck`.

## Chunk 4: Admin Web Site Consumer

### Task 8: Site-Only Admin Web Migration

**Files:**
- Modify: `kokoro-admin-web/components/shell/resource-table.tsx`
- Modify: `kokoro-admin-web/lib/resource-forms.ts`
- Modify if necessary: `kokoro-admin-web/lib/schemas.ts`

- [ ] Prefer contract-provided site form fields.
- [ ] Remove `site:*` entries from local `RESOURCE_FORMS` after site contract works.
- [ ] Keep other modules on old fallback.
- [ ] Run admin-web typecheck/build commands from the spec.

## Chunk 5: Final Verification

### Task 9: Full Site Gate

**Files:**
- No new files unless verification uncovers a bug.

- [ ] Run `pnpm --filter @kokoro/site db:generate`.
- [ ] Run `pnpm --filter @kokoro/site typecheck`.
- [ ] Run `pnpm --filter @kokoro/site test`.
- [ ] Run `pnpm --filter @kokoro/site test:integration`.
- [ ] If admin-web changed, run its typecheck/lint/test/build.
- [ ] Update docs with any implementation deviation and the reason.
