# kokoro-platform-kit Crosscutting Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-platform-kit` as a stateless crosscutting toolkit for env parsing, errors, global error handling, and internal HTTP calls.

**Architecture:** Keep platform-kit free of DB models and business DTOs. Formalize `AppError`, `defineEnv`, `registerErrorHandler`, and `callService` as generic primitives that business subrepos can compose without creating reverse dependencies.

**Tech Stack:** TypeScript, Zod, Fastify, Vitest.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-platform-kit` plus the platform-kit tech plan.
- Existing dirty/untracked kit files are intentional half-finished work and must be收束, not discarded.
- No Prisma schema or business soft-delete logic in this package.
- Use TDD for behavior changes.

## File Map

- Modify: `kokoro-platform-kit/src/config/env.ts`
  Keep `defineEnv` fail-loud and non-exiting.
- Modify: `kokoro-platform-kit/src/domain/errors.ts`
  Keep `AppError`, restrict `ERROR_STATUS` to generic cross-service codes.
- Modify: `kokoro-platform-kit/src/http/error-handler.ts`
  Normalize framework/client 4xx to `request.invalid`.
- Modify: `kokoro-platform-kit/src/http/internal-client.ts`
  Normalize URL join and preserve envelope behavior.
- Modify: `kokoro-platform-kit/src/index.ts`
  Export finalized primitives.
- Modify tests:
  - `kokoro-platform-kit/test/env.test.ts`
  - `kokoro-platform-kit/test/errors.test.ts`
  - `kokoro-platform-kit/test/error-handler.test.ts`
  - `kokoro-platform-kit/test/internal-client.test.ts`

## Chunk 1: Red Tests

### Task 1: Error Registry Boundary

**Files:**
- Modify: `kokoro-platform-kit/test/errors.test.ts`

- [ ] Add failing test that `ERROR_STATUS` keys do not start with business prefixes:
  - `credit.`
  - `payment.`
  - `site.`
  - `owner.`
  - `model.`
  - `user.`
- [ ] Add test that `new AppError("owner.inactive", 409, "...")` still supports business codes outside the registry.
- [ ] Run:

```bash
pnpm --filter @kokoro/platform-kit exec vitest run test/errors.test.ts
```

Expected: fail while business-specific keys remain in `ERROR_STATUS`.

### Task 2: Error Handler Boundary

**Files:**
- Modify: `kokoro-platform-kit/test/error-handler.test.ts`

- [ ] Add failing route that triggers a Fastify 4xx client error.
- [ ] Assert response code is 4xx and envelope code is `request.invalid`, not a Fastify internal code.
- [ ] Keep unknown 500 message redaction test.
- [ ] Run:

```bash
pnpm --filter @kokoro/platform-kit exec vitest run test/error-handler.test.ts
```

Expected: fail until client error code normalization is fixed.

### Task 3: Internal Client URL And Envelope Tests

**Files:**
- Modify: `kokoro-platform-kit/test/internal-client.test.ts`

- [ ] Add failing test for `baseUrl="http://svc/"` + `path="/x"` -> `http://svc/x`.
- [ ] Add failing test for `baseUrl="http://svc/api"` + `path="x"` -> `http://svc/api/x`.
- [ ] Add test that non-2xx error `details` is forwarded into `AppError.details`.
- [ ] Add test that success payload is schema validated.
- [ ] Run:

```bash
pnpm --filter @kokoro/platform-kit exec vitest run test/internal-client.test.ts
```

Expected: fail on URL normalization and details forwarding.

## Chunk 2: Implementation

### Task 4: Restrict Generic Error Registry

**Files:**
- Modify: `kokoro-platform-kit/src/domain/errors.ts`
- Modify: `kokoro-platform-kit/test/errors.test.ts`
- Modify if needed: `kokoro-platform-kit/test/error-handler.test.ts`

- [ ] Remove business-specific codes from `ERROR_STATUS`.
- [ ] Add generic codes:
  - `resource.conflict`
  - `upstream.error`
  - `internal.error`
- [ ] Keep `AppError` code as plain `string`.
- [ ] Update tests to use generic `appError()` examples.
- [ ] Run errors and error-handler tests.

Expected: tests pass and business modules can still construct `new AppError(customCode, status, ...)`.

### Task 5: Normalize Error Handler Client Errors

**Files:**
- Modify: `kokoro-platform-kit/src/http/error-handler.ts`

- [ ] Make Fastify/client 4xx responses use code `request.invalid`.
- [ ] Preserve client message if present.
- [ ] Keep requestId threading.
- [ ] Run error-handler tests.

Expected: framework code no longer leaks into envelope code.

### Task 6: Normalize Internal Client URLs And Details

**Files:**
- Modify: `kokoro-platform-kit/src/http/internal-client.ts`

- [ ] Add `joinUrl(baseUrl, path)` helper.
- [ ] Use helper before `fetch`.
- [ ] Parse optional error details from `{ error: { code, message, details } }`.
- [ ] Throw `AppError(code, res.status, message, details)`.
- [ ] Run internal-client tests.

Expected: URL and error mapping tests pass.

## Chunk 3: Gates And Commit

### Task 7: Full Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
pnpm --filter @kokoro/platform-kit typecheck
pnpm --filter @kokoro/platform-kit test
pnpm --filter @kokoro/platform-kit lint
git diff --check
```

- [ ] Because credit imports `AppError` and `callService`, also run:

```bash
pnpm --filter @kokoro/credit typecheck
pnpm --filter @kokoro/credit test
```

- [ ] Check no special business delete naming or forbidden external reference string was introduced.

Expected: all gates pass.

### Task 8: Scoped Commit

**Files:**
- Stage only `kokoro-platform-kit` implementation files and platform-kit tech plan.

- [ ] Inspect status:

```bash
git status --short
```

- [ ] Stage exact scope:

```bash
git add kokoro-platform-kit docs/platform/tech/2026-07-07-kokoro-platform-kit-crosscutting-hardening.md
```

- [ ] Inspect staged files:

```bash
git diff --cached --name-only
```

- [ ] Commit:

```bash
git commit -m "feat(platform-kit): harden crosscutting primitives"
```

Expected: commit contains platform-kit implementation only plus its tech-plan update.
