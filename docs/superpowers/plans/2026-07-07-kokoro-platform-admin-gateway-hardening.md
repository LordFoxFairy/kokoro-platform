# kokoro-platform-admin Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-platform-admin` as the service-side governance gateway for operator auth, RBAC, tenant scope, approval, audit, and manifest-bound module proxying.

**Architecture:** Keep business data in owning subrepos. `platform-admin` authenticates operators, resolves active accounts, checks permissions and site scope, allows only manifest-declared routes/actions, applies approval policy, forwards to modules, and records audit facts.

**Tech Stack:** TypeScript, Fastify, Zod, Prisma, jose, Vitest, `@kokoro/platform-kit`.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-platform-admin` plus its plan/tech docs.
- Existing dirty admin files are intentional half-finished work and must be收束, not discarded.
- Do not modify `kokoro-admin-web` in this chunk.
- Do not add Python files.
- DB lifecycle rule:
  - `OperatorAccount` uses `status=active|disabled` until a real delete/restore operator-management route exists.
  - `AuditLog` and `AuthEvent` are append-only facts.
  - `ApprovalRequest` is a state machine.
  - `VerificationToken` is ephemeral auth material and may be hard-pruned when expired.
- Use TDD for behavior changes.

## File Map

- Modify: `kokoro-platform-admin/src/gateway.ts`
  Add resource-list tenant filtering and explicit `siteId` support.
- Modify: `kokoro-platform-admin/src/server.ts`
  Accept `siteId` query on `/api/resource` and delegate scoped filtering.
- Modify: `kokoro-platform-admin/test/unit/gateway.test.ts`
  Add red tests for tenant-bounded resource reads.
- Modify as needed:
  - `kokoro-platform-admin/src/auth.ts`
  - `kokoro-platform-admin/src/config.ts`
  - `kokoro-platform-admin/src/rbac.ts`
  - `kokoro-platform-admin/.env.example`
  - `kokoro-platform-admin/prisma/schema.prisma`
  - `kokoro-platform-admin/test/unit/auth.test.ts`
  - `kokoro-platform-admin/test/unit/perms.test.ts`
  - `kokoro-platform-admin/test/unit/rbac.test.ts`
- Keep untracked `kokoro-admin-web/` out of this commit.

## Chunk 1: Red Tests

### Task 1: Resource Proxy Tenant Filtering

**Files:**
- Modify: `kokoro-platform-admin/test/unit/gateway.test.ts`

- [ ] Add test that a super-scoped operator can read all rows when no `siteId` is passed.
- [ ] Add test that a scoped operator without `siteId` only receives rows whose `siteId` is in `scopeSites`.
- [ ] Add test that rows missing `siteId` are not returned to a scoped operator.
- [ ] Add test that a scoped operator passing an out-of-scope `siteId` receives 403 before the upstream resource route is fetched.
- [ ] Run:

```bash
pnpm --filter @kokoro/platform-admin exec vitest run test/unit/gateway.test.ts
```

Expected: fail until `proxyResource` receives and enforces resource scope options.

### Task 2: `/api/resource` Query Contract

**Files:**
- Modify: `kokoro-platform-admin/test/unit/gateway.test.ts` or add route-level test if existing helpers are better.

- [ ] Cover `siteId` query parsing through server route if practical.
- [ ] Assert invalid query is 400 and auth errors stay 401.
- [ ] Assert scoped operator cannot use `/api/resource` to read another site.

Expected: route behavior matches gateway primitive.

## Chunk 2: Implementation

### Task 3: Add Resource Scope Options

**Files:**
- Modify: `kokoro-platform-admin/src/gateway.ts`

- [ ] Add `ResourceScopeOptions` with `operator?: Operator` and `siteId?: string`.
- [ ] Keep backward-compatible call sites by accepting undefined options.
- [ ] Validate resource permission when `operator` is present.
- [ ] Validate requested `siteId` against `operator.scopeSites`.
- [ ] After upstream response, filter rows:
  - super scope and no `siteId`: all rows.
  - requested `siteId`: only rows matching that site.
  - scoped operator without `siteId`: only rows matching `scopeSites`.
  - scoped operator rows without string `siteId`: drop.
- [ ] Ensure denied reads do not fetch the upstream resource route after manifest fetch.

Expected: resource read path has the same service-side tenant boundary as action path.

### Task 4: Wire `/api/resource`

**Files:**
- Modify: `kokoro-platform-admin/src/server.ts`

- [ ] Add optional `siteId` to `resourceQuerySchema`.
- [ ] Pass `{ operator, siteId }` into `proxyResource`.
- [ ] Preserve existing error envelope and status mapping.

Expected: UI/BFF can request explicit site reads, while scoped reads are still bounded when no siteId is passed.

### Task 5: Keep Aggregations Correct

**Files:**
- Modify: `kokoro-platform-admin/src/gateway.ts`
- Modify tests as needed.

- [ ] Keep `getSites` using unscoped internal fetch then explicit site filtering.
- [ ] Keep `getUser360` doing its own route-level site check in `server.ts`, then scoped aggregation by query.
- [ ] Avoid adding business-specific DB logic to platform-admin.

Expected: aggregation endpoints keep current behavior and remain tenant-bounded by their route guards.

## Chunk 3: Verification And Commit

### Task 6: Scoped Gates

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/platform-admin typecheck
pnpm --filter @kokoro/platform-admin test
pnpm --filter @kokoro/platform-admin lint
git diff --check
```

- [ ] If Prisma schema/migration is changed in implementation, run:

```bash
pnpm --filter @kokoro/platform-admin db:generate
```

- [ ] Scan for forbidden external reference text and nonstandard delete helper names before commit.

Expected: all platform-admin gates pass.

### Task 7: Scoped Commit

**Files:**
- Stage only platform-admin implementation files plus:
  - `docs/platform/tech/2026-07-07-kokoro-platform-admin-gateway-hardening.md`
  - `docs/superpowers/plans/2026-07-07-kokoro-platform-admin-gateway-hardening.md`

- [ ] Inspect status:

```bash
git status --short
```

- [ ] Stage exact scope.
- [ ] Inspect staged files:

```bash
git diff --cached --name-only
```

- [ ] Commit docs first:

```bash
git commit -m "docs(platform-admin): add gateway hardening plan"
```

- [ ] After implementation and gates, commit implementation:

```bash
git commit -m "feat(platform-admin): enforce scoped resource reads"
```

Expected: plan commit and implementation commit are separated.
