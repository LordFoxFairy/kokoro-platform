# kokoro-admin-web BFF Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `kokoro-admin-web` into git as a working Next.js/Auth.js/Ant Design Pro BFF and operations console, with explicit tenant context, reproducible env, generated Prisma client, and passing gates.

**Architecture:** Browser requests hit Next.js. Auth.js handles magic-link login. Middleware injects operator/proxy headers for non-auth `/api/*`. Next rewrites those API calls to `kokoro-platform-admin`, which remains the service-side authority for RBAC, tenant scope, approval, and audit.

**Tech Stack:** Next.js 15.5.19 App Router, React 18, Auth.js v5 beta, Ant Design 5, Ant Design Pro Components, Prisma, Zod, Vitest.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-admin-web`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and admin-web plan/tech docs.
- Do not stage `.env.local`, `.next/`, `node_modules/`, `next-env.d.ts`, or `tsconfig.tsbuildinfo`.
- Next package has no `node_modules/next/dist/docs/` in version `15.5.19`; use local README/types and `next build` as authoritative gate.
- Use Ant Design Pro patterns already in the package.

## Baseline

- `pnpm --filter @kokoro/admin-web test`: pass, 9 tests.
- `pnpm --filter @kokoro/admin-web lint`: pass.
- `pnpm --filter @kokoro/admin-web build`: fail, Prisma generated client does not include `operatorAccount`.

## File Map

- Modify: `kokoro-admin-web/.gitignore`
  Allow `.env.example` while keeping real env files ignored.
- Modify: `kokoro-admin-web/package.json`
  Add `db:generate`, `typecheck`, and build precondition if needed.
- Modify: `kokoro-admin-web/lib/env.ts`
  Enforce production SMTP settings and make env parser testable.
- Modify: `kokoro-admin-web/components/shell/resource-table.tsx`
  Pass `siteId` to `/api/resource` for site-scoped reads and dropdown sources.
- Modify: `kokoro-admin-web/components/shell/endpoint-table.tsx`
  Support optional current-site query for endpoints such as audit.
- Modify: `kokoro-admin-web/app/audit/page.tsx`
  Request audit with current `siteId`.
- Modify: `kokoro-admin-web/app/users/page.tsx`
  Pass `siteId` when loading plan options.
- Modify: `kokoro-admin-web/app/login/page.tsx`
  Remove decorative glow and negative letter-spacing classes.
- Add/modify tests:
  - `kokoro-admin-web/lib/env.test.ts`
  - existing `kokoro-admin-web/lib/auth/adapter.test.ts`
  - optional `kokoro-admin-web/lib/api.test.ts`

## Chunk 1: Red Tests

### Task 1: Env Production SMTP

**Files:**
- Add: `kokoro-admin-web/lib/env.test.ts`
- Modify: `kokoro-admin-web/lib/env.ts`

- [ ] Refactor env parsing into `parseEnv(source)` without changing `env = parseEnv(process.env)`.
- [ ] Add failing test: production with missing SMTP host/port fails.
- [ ] Add passing test: development can omit SMTP and keep console-link behavior.
- [ ] Run:

```bash
pnpm --filter @kokoro/admin-web exec vitest run lib/env.test.ts
```

Expected: fail until production SMTP validation is implemented.

### Task 2: Tenant Query Helpers

**Files:**
- Add or modify: `kokoro-admin-web/lib/api.test.ts`
- Modify: `kokoro-admin-web/lib/api.ts`

- [ ] Add test that `queryString` includes `siteId` and preserves slash routes.
- [ ] Keep existing helper behavior for moduleId/route.

Expected: helper remains deterministic before wiring component call sites.

## Chunk 2: Implementation

### Task 3: Fix Prisma Client Drift

**Files:**
- Modify: `kokoro-admin-web/package.json`

- [ ] Add script:

```json
"db:generate": "prisma generate"
```

- [ ] Add `typecheck` script if useful:

```json
"typecheck": "tsc --noEmit"
```

- [ ] Ensure build runs after generate, either by documenting gate or using `prebuild`.
- [ ] Run:

```bash
pnpm --filter @kokoro/admin-web exec prisma generate
pnpm --filter @kokoro/admin-web build
```

Expected: `operatorAccount` exists on PrismaClient and build gets past typecheck.

### Task 4: Commit Env Example

**Files:**
- Modify: `kokoro-admin-web/.gitignore`
- Include: `kokoro-admin-web/.env.example`

- [ ] Change `.gitignore` to ignore `.env*` but allow `.env.example`.
- [ ] Keep `.env.local` ignored.
- [ ] Verify:

```bash
git ls-files --others --exclude-standard kokoro-admin-web/.env.example
git status --short --ignored kokoro-admin-web/.env.local
```

Expected: example is trackable, local env remains ignored.

### Task 5: Wire Explicit Site Context

**Files:**
- Modify: `kokoro-admin-web/components/shell/resource-table.tsx`
- Modify: `kokoro-admin-web/components/shell/endpoint-table.tsx`
- Modify: `kokoro-admin-web/app/audit/page.tsx`
- Modify: `kokoro-admin-web/app/users/page.tsx`

- [ ] Add helper to build resource query params:
  - include `moduleId` and `route`
  - include `siteId` when a selected site exists
  - skip `siteId` for `site:sites`
- [ ] Use helper in `ResourceTable.request`.
- [ ] Use helper for `optionsFrom.siteScoped`.
- [ ] In user 360 plan dropdown, pass selected `siteId`.
- [ ] Add `siteScoped` prop to `EndpointTable`; when true, require current site and append `siteId`.
- [ ] Set audit page to `siteScoped`.

Expected: UI default behavior matches selected site and platform-admin service-side filtering.

### Task 6: Visual Compliance Cleanup

**Files:**
- Modify: `kokoro-admin-web/app/login/page.tsx`
- Modify other files only if scan finds direct violations.

- [ ] Remove decorative glow layers.
- [ ] Replace negative letter-spacing utility classes with normal tracking.
- [ ] Keep login page functional and focused on auth, not a marketing hero.
- [ ] Scan:

```bash
rg -n "tracking-tight|blur-3xl|rounded-full bg-primary/25|radial-gradient" kokoro-admin-web/app kokoro-admin-web/components
```

Expected: no prohibited decorative patterns in committed UI code.

## Chunk 3: Gates And Commit

### Task 7: Full Verification

- [ ] Run:

```bash
pnpm --filter @kokoro/admin-web db:generate
pnpm --filter @kokoro/admin-web test
pnpm --filter @kokoro/admin-web lint
pnpm --filter @kokoro/admin-web typecheck
pnpm --filter @kokoro/admin-web build
git diff --check
```

- [ ] Scan for forbidden external reference text and nonstandard delete helper names.
- [ ] Confirm ignored files are not staged.

Expected: all admin-web gates pass.

### Task 8: Scoped Commit

**Stage only:**

- `kokoro-admin-web` source/config files that are not ignored.
- `kokoro-admin-web/.env.example`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- admin-web docs:
  - `docs/platform/tech/2026-07-07-kokoro-admin-web-bff-hardening.md`
  - `docs/superpowers/plans/2026-07-07-kokoro-admin-web-bff-hardening.md`

- [ ] Commit docs first:

```bash
git commit -m "docs(admin-web): add bff hardening plan"
```

- [ ] Commit implementation after gates:

```bash
git commit -m "feat(admin-web): add governed operations console"
```

Expected: docs and implementation are separate commits; generated/local files are excluded.
