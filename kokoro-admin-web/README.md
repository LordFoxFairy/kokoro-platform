# Kokoro Admin Web

Next.js BFF and Ant Design Pro operations console for Kokoro Platform.

## Runtime

- Next.js App Router renders the console and owns Auth.js magic-link login.
- `/api/auth/*` is handled by Auth.js.
- Other `/api/*` requests are same-origin rewrites to `kokoro-platform-admin`.
- Middleware injects `x-kokoro-operator` and `x-kokoro-proxy-secret`; platform-admin remains the authority for RBAC, tenant scope, approval, and audit.

## Environment

Copy `.env.example` to `.env.local` and fill real values.

Important local defaults:

- `AUTH_URL` must match the browser host used for login, for example `http://localhost:3000`.
- `KOKORO_GATEWAY_URL` points to platform-admin, usually `http://127.0.0.1:4290`.
- `KOKORO_ADMIN_PROXY_SECRET` must match one value in platform-admin `KOKORO_ADMIN_PROXY_SECRETS`.
- SMTP may be omitted in development; magic links print to the server console.

## Commands

```bash
pnpm --filter @kokoro/admin-web db:generate
pnpm --filter @kokoro/admin-web dev
pnpm --filter @kokoro/admin-web test
pnpm --filter @kokoro/admin-web lint
pnpm --filter @kokoro/admin-web typecheck
pnpm --filter @kokoro/admin-web build
```

## Data Boundary

This package does not own business data or migrations. Its Prisma schema only maps admin DB tables needed for login:

- `OperatorAccount` is read to allow only active operators.
- `VerificationToken` stores one-time magic-link tokens.
- `AuthEvent` records sign-in, sign-out, and denied login events.
