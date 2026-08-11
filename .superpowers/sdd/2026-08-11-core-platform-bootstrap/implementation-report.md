# Core Platform Bootstrap implementation report

Status: DONE_WITH_CONCERNS

## Completed

- Task 1 strict `0600` bootstrap document, Direct-only schema, code-owned `account/chat/redemption` surfaces, secret-digest config binding, deterministic UUID/idempotency recipe, and Site release certification material.
- Task 2 admin-only verified personal account application service. It uses the existing Identity repository, shared UoW, command receipts, authorization mutation and exactly one namespace-allocation event; it skips the public verification-delivery ceremony and creates no starter Credit.
- Task 3 `fixed_http` Site deployment provider with exact metadata binding, timeout/abort/redirect/error handling and backward-compatible untagged RPC registry parsing.
- Task 4 optional redemption entropy injection. The default remains `randomBytes(20)`; a bootstrap may inject a secret-keyed deterministic 20-byte source without changing code format, normalization or HMAC domains.
- Platform deployable readiness was not changed. Payment, Media, Memory and Site Fleet were not enabled.

## TDD evidence

Every completed production slice began with a focused failing test caused by the missing export/behavior. The document UUID domain mutation was manually changed and the exact-vector test failed before restoration.

Focused verification:

- 7 Vitest files, 44 tests passed.
- Repository gate: 31 tests passed.
- `pnpm run typecheck` passed.
- `pnpm run lint` passed.
- `pnpm run build:runtime` passed.
- `git diff --check` passed.

The host supplied Node 22.22.2 while the repository declares Node >=24; pnpm emitted the existing engine warning. TypeScript, runtime build and tests still completed successfully.

## Remaining concerns / uncompleted plan items

Tasks 5 and 6 are not represented as completed code. The initial plan omitted two authorities required by the real Site chain. The parent subsequently resolved them as follows, but the remaining implementation did not fit this slice:

1. The CLI must accept maker/checker attestation and public-key arguments, verify signatures and re-run `verifyRequestSecurityContext` for every closed operation. Subject, role, workload kind, operation set, audience, environment, region and expiry must bind exactly. Refreshed attestations for the same operators stay outside the stable business config digest.
2. Site release certification must use `parseSiteReleaseCertificationKeys` plus `Ed25519SiteReleaseCertificationAuthority` from the existing `PLATFORM_SITE_RELEASE_CERTIFICATION_KEYS_FILE`; bootstrap never holds a signing private key.
3. The production composition must still call the existing Site, Model, Admission, Rating, Commerce and Identity application services in the required order, publish result/code files atomically, and add the compiled CLI selector.
4. The real fresh PostgreSQL authority test, crash/replay closure, code-file reconstruction after commit, configuration/secret drift test and Commerce→Credit redemption lineage remain outstanding.

No generic orchestrator, fake verified context, migrator shortcut, fixture copy, new state table or partial CLI was committed.
