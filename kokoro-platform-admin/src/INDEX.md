# Platform Admin source map

Admin Auth is exposed only through the generated `kokoro.platform.admin.v1.AdminAuthService` Connect provider:

- `admin-auth-connect.ts` composes Fastify Connect, Protovalidate, workload authentication and typed safe errors.
- `admin-auth-service.ts` owns command/query behavior and consumes the Root-generated canonical Effect digest helper.
- `admin-auth-receipt.ts` owns idempotency, digest conflicts and receipt reconciliation.
- `admin-auth-store.ts` keeps operator, token, auth-event and receipt persistence inside one Prisma owner boundary.
- `generated/contracts/**` is the Root Proto/Buf-generated mirror, including the Node-only canonical Effect digest helper. Never edit it by hand.

Command receipts persist both `digestAlgorithm=sha256_protobuf_v1` and the 64-character digest. Proto request bounds match the MySQL `VARCHAR(191)` owner schema, so contract-valid input cannot fail later only because an indexed auth field is too wide.

The package version (`.v1`) is the contract version. There is no custom version header or hand-written Admin Auth HTTP route.
