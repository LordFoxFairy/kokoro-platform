---
architectureIndex: 1
rootId: platform.user
owners:
  - "@LordFoxFairy"
---

# User and identity module

## Responsibilities
Own current user identity, authentication-related application workflows, email adapter, and user administration records.

## Non-responsibilities
User does not own Admin operators, Session messages, Site Web cookies, or cross-Site account federation by implicit shared rows.

## Public boundary
`UserService`, `TeamService`, `SessionService`, `RefreshService`, and `MagicLinkService` (`src/application/`) are the application services. HTTP splits into an internal surface (`/users/ensure`, `/users/:userId` delete/restore, `/owners/:ownerKind/:ownerId/active`, `/teams/upsert`, `/teams/:teamId` delete/restore, `/memberships/check`, `/memberships/change-role`, `/service-accounts/:serviceAccountId`, `/me/teams`), an auth surface (`/auth/sessions`, `/auth/magic-links` + `/consume`, `/auth/refresh` + `/revoke`, `GET /.well-known/jwks.json`), a team self-service BFF surface keyed by the `x-user-id` principal the Web BFF injects (`/bff/me/teams`, `/bff/me/invites`, `/bff/teams/:teamId`, `/bff/teams/:teamId/invites`, `/bff/teams/:teamId/members/change-role|remove`, `/bff/invites/:inviteId/accept|decline`, `/bff/auth/team-sessions`), and admin (`/admin/users/:id/disable|enable` plus the `userAdminManifest` lists). `src/index.ts` re-exports the services above except `RefreshService`, plus `createUserServer`, `userAdminManifest`, `userPlatformModule`, the JOSE signing helpers, and the domain/repository contracts; persistence and email adapters stay private. A second entry point `@kokoro/user/contract` exposes `src/interfaces/http/schemas.ts` alone, so a peer service can bind to this service's wire contract without pulling in its Prisma client, Fastify server, ioredis, jose or nodemailer. The root no longer re-exports that module, so `./contract` is the only way to reach these schemas: a peer that imports them from the package root now fails to compile rather than relying on the architecture gate to catch it.

## Callers and dependencies
Platform identity orchestration and trusted Web backends call this module through declared APIs.

## Data ownership and events
This package owns user/auth records, subject generation, migrations, and user-domain events within its current schema.

## Runtime and security
`DATABASE_URL_USER` is this package's private Prisma datasource; `KOKORO_USER_PORT` (4211) binds the service and `KOKORO_USER_BASE_URL` is its advertised address. Session issuance is RS256 via `KOKORO_USER_JWT_PRIVATE_KEY` (`_PREVIOUS` keeps the rotated public key in JWKS); `KOKORO_AUTH_JWT_SECRET` is the dev-only HS256 fallback and production fails fast without a private key. `KOKORO_AUTH_JWT_ISSUER`, `KOKORO_AUTH_JWT_TTL_SECONDS`, `KOKORO_AUTH_REFRESH_TTL_SECONDS`, and `KOKORO_TEAM_INVITE_TTL_SECONDS` set lifetimes. Magic links read `KOKORO_AUTH_MAGIC_DELIVERY` (`response` is refused in production), `KOKORO_AUTH_MAGIC_TTL_SECONDS`, `KOKORO_AUTH_MAGIC_LINK_BASE_URL`, `KOKORO_SMTP_*`, `KOKORO_AUTH_MAGIC_RATE_*`, and optional `KOKORO_REDIS_URL` for multi-replica rate limiting. Authentication inputs are untrusted, tokens require expiry/audience policy, and Site/account association is resolved server-side.

## Idempotency, failure, and recovery
Identity effects require stable command identity, unique constraints, token one-time semantics, and auditable recovery.

## Extension rules and forbidden dependencies
Add identity behavior through application ports. Cross-Site federation must use explicit OAuth/federation, never direct account-table sharing.

## Current gotchas
Wave 1 still must freeze final Site-scoped Identity/Workspace/Project and RequestSecurityContext contracts.

## Verification
Run `pnpm --filter @kokoro/user test`, typecheck/lint, migrations, and identity security integration tests.
