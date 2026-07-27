# Platform Admin source map

Admin Auth is exposed only through the generated `kokoro.platform.admin.v1.AdminAuthService` Connect provider:

- `admin-auth-connect.ts` composes Fastify Connect, Protovalidate, workload authentication and typed safe errors.
- `admin-auth-service.ts` owns normalization and command/query behavior.
- `admin-auth-receipt.ts` owns idempotency, digest conflicts and receipt reconciliation.
- `admin-auth-store.ts` keeps operator, token, auth-event and receipt persistence inside one Prisma owner boundary.
- `generated/contracts/**` is the Root Proto/Buf-generated mirror. Never edit it by hand.

The package version (`.v1`) is the contract version. There is no custom version header or hand-written Admin Auth HTTP route.
