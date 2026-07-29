# Commerce module

Commerce is a Platform-local owner module. It shares the Platform PostgreSQL database and `PlatformUnitOfWork`; it never calls
Platform through HTTP/RPC and never exposes a Prisma client to application code.

## Authority in this slice

- `platform.command_receipt` remains the sole idempotency/result authority. `commerce_command` is a Site/actor/version snapshot
  with a foreign key to that receipt, not a second receipt implementation.
- BillingAccount and its Site-scoped subject membership are owner facts. User commands resolve membership after the command identity
  fence at the BillingAccount node in the shared lock DAG.
- Fulfillment transaction, frozen expected output lines, actual output occurrences, generic outbox links, and append-only audit entries
  commit in one `PlatformUnitOfWork`.
- The database rejects non-contiguous output plans, output mutation, illegal fulfillment transitions, and successful fulfillment whose
  actual multiset does not exactly satisfy the frozen plan.

Catalog, Subscription, Entitlement, Credit, Code inventory, and HTTP command workflows remain later owner slices. Their ports accept
only the opaque `PlatformTransaction`; no sibling module may introduce a second transaction or self-RPC.
