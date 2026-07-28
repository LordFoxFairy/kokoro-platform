---
architectureIndex: 1
rootId: platform.admin
owners:
  - "@LordFoxFairy"
---

# Platform Admin service

## Responsibilities
Expose privileged Platform administration APIs, own Admin Auth persistence/effects, and compose module administration workflows.

## Non-responsibilities
Admin Web does not share this service's database, and this service does not render UI or own public Site sessions.

## Public boundary
Two remote surfaces: the `createAdminServer` gateway's explicitly registered `/api/*` endpoints (`me`, `manifests`, `openapi/:moduleId`, `operators`, `roles`, `sites`, `billing-overview`, `user360`, `resource`, `action`, `approvals`, `audit`) and the generated Admin Auth Connect provider — see [`src/INDEX.md`](src/INDEX.md) for its contract, digest, and receipt rules.

## Callers and dependencies
Admin Web calls both surfaces; the gateway fans out to the site/user/model/credit/payment/hub module manifests with raw `fetch` in `gateway.ts`, stamping `x-kokoro-service: admin` plus the internal secret so each module's `registerRouteAccess` can authorize it.

## Data ownership and events
This package owns operator, RBAC, approval, and audit records, plus the Admin Auth tables listed in `src/INDEX.md`, and its Prisma migrations.

## Runtime and security
`DATABASE_URL_ADMIN` is this package's private Prisma datasource; `KOKORO_ADMIN_PORT` (4290) binds the service. Operator authentication is `KOKORO_ADMIN_AUTH_MODE` = `oidc` (default; `KOKORO_ADMIN_OIDC_*`), `proxy` (`KOKORO_ADMIN_PROXY_SECRETS`, comma-separated for rotation), or `dev` (`KOKORO_ADMIN_DEV_OPERATOR`). Outbound module calls carry `KOKORO_INTERNAL_SECRET_ADMIN` — production refuses to boot without it — and `KOKORO_APPROVAL_GRANT_THRESHOLD_MICROS` forces second approval on large grants. Peer addresses come from `KOKORO_{SITE,USER,MODEL,CREDIT,PAYMENT,HUB}_BASE_URL`.

Resource reads are manifest-driven and fail closed: an operator is mandatory, every generic resource whose `siteScopeField` is non-null requires one explicit non-blank concrete `siteId`, and omission or `*` returns `400 site_required` before its resource provider is called. The generic gateway never infers or fans out Site scope. Returned rows are checked again against the declared `siteScopeField`. `siteScopeField: null` remains an explicit platform-global contract and requires wildcard Site scope with no `siteId`. `/api/sites` is the deliberate directory exception: wildcard operators receive its permission-checked full directory, while finite operators are fetched through explicit concrete Site filters. `/api/billing-overview` additionally requires `billing.read`, an in-scope `siteId`, and forwards that Site to both stats providers. Seeded ops/finance/readonly roles have `billing.read`; support does not. `/api/openapi/:moduleId` additionally requires `docs.read`, accepts only a fixed registered module ID, and proxies bounded JSON from the module's fixed `/docs/json` target; browser responses and manifests never expose internal base URLs or service credentials.

## Idempotency, failure, and recovery
`/api/action` runs prepare → permission check → approval gate → execute, and `gateway.ts` writes an `AuditLog` row for every denial, transport failure, and completed forward. Admin Auth effect-command idempotency is documented in `src/INDEX.md`.

## Extension rules and forbidden dependencies
Add privileged workflows through application services and generated contracts. Admin Web must reach Platform data only through this service, never through its own Prisma client.

## Current gotchas
Gateway `/api/*` endpoints are hand-written Fastify routes with Zod-shaped payloads; only Admin Auth has a generated contract.

## Verification
Run package unit/integration tests, typecheck/lint, fresh migrations, and Root Admin Auth compatibility.
