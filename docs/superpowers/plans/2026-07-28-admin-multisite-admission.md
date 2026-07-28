# Admin Multi-site Admission Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Admin read surface explicitly declare and enforce its Site scope before provider pagination, including Site-scoped billing aggregates.

**Architecture:** `AdminResourceManifest.siteScopeField` is the authoritative contract (`"siteId"`, `"id"`, or `null`). The Admin gateway validates permissions and operator scope from this metadata, forwards one explicit `siteId` query per finite Site, and validates returned rows; each provider applies that filter in Prisma before `take`. Platform-global resources are readable only by wildcard-scoped operators.

**Tech Stack:** TypeScript, Fastify, Zod, Prisma, Vitest, pnpm.

---

## Chunk 1: Manifest and gateway contract

### Task 1: Require explicit resource scope metadata

**Files:**
- Modify: `kokoro-platform-kit/src/admin/manifest-schema.ts`
- Modify: `kokoro-platform-kit/test/admin-manifest-schema.test.ts`
- Modify: all six module `src/interfaces/admin/*-admin-contract.ts` files
- Modify: corresponding admin manifest contract tests

- [ ] Write tests proving missing/invalid `siteScopeField` is rejected and every real resource declares the correct field.
- [ ] Run the focused manifest tests and observe the expected failures.
- [ ] Add the required nullable enum field and update all real manifests.
- [ ] Re-run the focused tests until green.

### Task 2: Enforce metadata-driven gateway scope

**Files:**
- Modify: `kokoro-platform-admin/src/gateway.ts`
- Modify: `kokoro-platform-admin/src/server.ts`
- Modify: `kokoro-platform-admin/test/unit/gateway.test.ts`
- Modify: `kokoro-platform-admin/prisma/seed.ts`

- [ ] Write failing tests for A/B isolation, finite multi-Site fan-out, provider query forwarding, `null` rejection, `/api/sites` permission/id filtering, and billing permission/Site scope.
- [ ] Run the focused gateway tests and verify failures are behavioral.
- [ ] Implement fail-closed resource routing, required operator context, per-Site provider calls, response-field validation, `/api/sites`, and `billing.read` enforcement.
- [ ] Re-run gateway tests until green.

## Chunk 2: Provider pre-pagination isolation

### Task 3: Add strict Site queries and repository filtering

**Files:**
- Modify: Credit, Model, Payment, Site, and User admin routes and repository contracts/Prisma implementations
- Modify: provider admin/repository tests

- [ ] Write failing provider tests for strict query parsing, A/B isolation, filtering before `take`, relationship-derived `siteId`, and Site-filtered stats.
- [ ] Run each affected package test and record the expected failures.
- [ ] Add strict Zod query schemas and pass `siteId` to repositories.
- [ ] Add Prisma `where` clauses before `take`; project relation-owned `siteId` on Credit ledger/usage, Payment subscription/refund, and User membership/service-account rows.
- [ ] Make Credit and Payment stats require a Site and aggregate only that Site.
- [ ] Re-run focused provider tests until green.

## Chunk 3: Documentation, verification, and handoff

### Task 4: Document and verify the boundary

**Files:**
- Modify: `kokoro-platform-kit/INDEX.md`
- Modify: `kokoro-platform-admin/INDEX.md`
- Modify: `kokoro-credit/INDEX.md`
- Modify: `kokoro-model/INDEX.md`
- Modify: `kokoro-payment/INDEX.md`
- Modify: `kokoro-site/INDEX.md`
- Modify: `kokoro-user/INDEX.md`
- Modify: `kokoro-hub/INDEX.md`

- [ ] Update each INDEX with its scope mapping and runtime enforcement rule.
- [ ] Run affected unit/integration tests without Docker.
- [ ] Run platform typecheck, lint, and the broadest non-container test gate available.
- [ ] Review the full diff for scope omissions, generated files, secrets, and unrelated changes.
- [ ] Commit the verified change and report base/head plus manifest/wire mapping.
