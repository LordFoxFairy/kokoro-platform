---
architectureIndex: 1
rootId: platform.site
owners:
  - "@LordFoxFairy"
---

# Site module

## Responsibilities
Own Site identity, host/config resolution, lifecycle state, branding/configuration, and current Site administration APIs.

## Non-responsibilities
Site does not render a Site Web project, share user accounts across Sites, or own subscription/credit facts.

## Public boundary
`SiteService` (`src/application/site-service.ts`) is the only application service. HTTP serves `/sites` (list, `upsert`, `:siteId` delete/restore/`active`), `/site-domains` (`upsert`, `:domainId` delete/restore/`verify`/`mark-verified`), `/site-apps/upsert`, `/site-policies/upsert`, `/site-feature-flags` (list, `upsert`), and `GET /site-context/resolve`; admin adds read-only lists derived from `siteAdminManifest` at `/admin/sites`, `/admin/site-domains`, `/admin/site-apps`, `/admin/site-policies`, `/admin/site-feature-flags`. `src/interfaces/cli/seed-default-site.ts` seeds the default Site. `src/index.ts` re-exports `SiteService`, `siteAdminManifest`, `sitePlatformModule`, and the domain contracts — `createSiteServer` is not re-exported, so in-process consumers import it from `src/interfaces/http/server.js`. A second entry point `@kokoro/site/contract` exposes `src/interfaces/http/schemas.ts` alone, so a peer service can bind to this service's wire contract without pulling in the rest of the package. The root no longer re-exports that module, so `./contract` is the only way to reach these schemas: a peer that imports them from the package root now fails to compile rather than relying on the architecture gate to catch it.

## Callers and dependencies
Web/Platform resolve Site context through server-side APIs; private Prisma data is never read directly by other services.

## Data ownership and events
This package owns Site records, host mappings, lifecycle/config revisions, migrations, and Site-domain events.

## Runtime and security
`DATABASE_URL_SITE` is this package's private Prisma datasource; `KOKORO_SITE_PORT` (4201) binds the service and `KOKORO_SITE_BASE_URL` is its advertised address. Inbound calls are authenticated by the per-caller registry (`KOKORO_INTERNAL_SECRET_<CALLER>`); the single legacy `KOKORO_INTERNAL_SECRET` is template compatibility only. `KOKORO_SITE_ID`/`KOKORO_SITE_NAME` only steer the seed CLI, which enforces the `site-<key>` id convention. Unknown production hosts fail closed. Site context is server-resolved and cannot be selected by an untrusted browser field.

## Idempotency, failure, and recovery
Site creation/config publication use stable identities and revisions; release activation/rollback require auditable attempts in Wave 1.

## Extension rules and forbidden dependencies
Add Site business rules to domain/application and adapters to interfaces/infrastructure. Do not couple one Site to another Site's account state.

## Current gotchas
Independent Site Web artifact/fleet release authority is not fully implemented by this module yet.

## Verification
Run `pnpm --filter @kokoro/site test`, typecheck/lint, migrations, and multi-host isolation tests.
