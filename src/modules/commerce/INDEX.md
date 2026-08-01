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
- `FulfillmentService` plus the source-neutral `PostgresFulfillmentIssuer` are the Commerce issuance authority. Redemption and Payment
  settlement are acquisition adapters: they
  submit a Site-scoped source identity plus immutable product/plan/offering/program/output-plan/acquisition snapshots. The service
  derives the sole SHA-256 idempotency fence from Site + source type + source ref + purpose + cycle and replays the stored receipt
  without issuing SubscriptionTerms, EntitlementGrants, or CreditGrants again. Payment sources additionally require a frozen pricing
  snapshot reference before the owner accepts them.
- Commerce owns SubscriptionTerm and EntitlementGrant persistence. CreditGrant issuance crosses only the Credit application-owned
  `CreditGrantIssuancePort` with the same branded `PlatformTransaction`: Commerce prepares the exact account authority before claiming
  acquisition facts, then Credit atomically owns CreditAccount, CreditGrant and Journal SQL. Commerce must not import Credit
  infrastructure or mutate `platform.credit_*` tables. The opaque preparation capability is transaction-bound and one-shot, and the
  returned Credit receipt multiset must exactly match the frozen fulfillment output plan.
- The database rejects non-contiguous output plans, output mutation, illegal fulfillment transitions, and successful fulfillment whose
  actual multiset does not exactly satisfy the frozen plan.

## Redemption acquisition

- Product, Plan, CreditProgram, EntitlementTemplate, FulfillmentProgram, and RedemptionProgram revisions are immutable published
  facts. Operational availability lives on mutable parent/availability records instead of rewriting a published revision.
- Code inventory stores only a Site-domain-separated HMAC lookup digest and an independent keyed safe fingerprint. Raw and normalized
  Code material exists only in the request stack while the HMAC is computed; it is forbidden from receipts, outbox, audit, errors,
  logs, and projections.
- Preview is a non-reserving read of active inventory. Its short-lived opaque credential is bound to Site, subject generation,
  BillingAccount, Code identity, and frozen product/program/output-plan digests. The credential is reconstructed with its stored key
  revision, so key rotation cannot silently return a credential that confirm would reject.
- `previewRedemption` is a required production public operation. It uses the generic command receipt fence and returns the same safe
  preview on an exact idempotent replay while the preview remains live.
- `confirmRedemption`, command recovery, and durable receipt reads are public operations. Confirmation re-locks every mutable
  authority, binds the effect to the database clock, claims the Code, and invokes the shared Fulfillment authority atomically. Code
  identity—not a newly generated receipt id—is the stable redemption acquisition source.
- The latest release supports permanent Credit packs, immutable non-renewing SubscriptionTerms, and EntitlementGrants. Daily/period
  Credit programs fail closed in redemption until calendar-window acquisition is a real owner workflow; relative-expiry grants are
  not used as an approximation.
- Fulfilled-redemption outbox events are reconciled by the Platform worker against the durable Redemption and fulfillment projection
  before delivery is completed, with bounded retry and dead-letter handling. The callable runtime immediately confirms and starts a
  one-third-window heartbeat for every lease in the complete claimed batch, including items queued behind a slow delivery. Ownership
  is rechecked after projection and before transport dispatch. Process abort never consumes retry budget; renewal loss aborts an
  in-flight transport and forbids dispatch, completion or retry. Its stop-claiming and exact worker/`commerce-worker`/event-allowlist
  lease-return phases are part of the production worker shutdown lifecycle.

## Admin control plane

- `AdminCommerceService` is a closed typed Connect surface mounted only on the Admin mTLS listener. Admin authenticates the
  operator, verifies exact Site scope/permission/fresh step-up and the canonical protobuf command digest; Commerce remains the
  application/repository owner and never accepts a generic route or action proxy.
- All ten Admin write operations bind retries to the full persisted command identity. Exact retries restore the original durable
  result and database-recorded receipt time after revalidating its SHA-256 digest; identity/digest drift becomes a typed Connect
  conflict and replay never reconstructs a result from mutable business tables.
- CreditProgram and EntitlementTemplate prerequisites have independent publish/list/get operations. Publication writes an immutable
  Site-scoped revision, its canonical content digest, command receipt and audit entry in one Platform transaction. Credit scope is a
  typed policy (surface, capability and Agent sets), and daily/period window facts are complete-or-rejected before persistence.
- Display labels have the same fail-closed rule at the protobuf, application, read-projection, and PostgreSQL boundaries: 1–160
  Unicode code points, exact NFC, no boundary Unicode space separator, and no Cc/Cf/Zl/Zp character. All four persisted label columns
  call one database validator whose category table is pinned to Unicode 17.0.
- The application rejects malformed calendar-zone syntax early, but PostgreSQL `pg_timezone_names.name` is the final IANA authority
  before a catalog epoch can be allocated. Persisted recurring windows use the same database authority; Node/ICU support is never
  allowed to redefine the catalog.
- `PublishOffer` freezes Product, optional PlanVersion, ordered FulfillmentProgram outputs, ProductVersion and legal references in
  one transaction. Output ordinals are contiguous, line ids are unique, and product/plan/output shape is checked before persistence.
- Code batches follow `draft -> active -> suspended -> revoked`, with `draft -> abandoned` as recovery when the one-time secret
  delivery is lost. Approval is a separate maker-checker fact; activation requires it. Abandon/revoke void unused inventory.
- Raw codes are capped at 1,000, returned only by the first committed Issue response, and never written to storage, receipts, audit,
  errors or query DTOs. An exact command replay returns `delivery_unavailable`; batch queries expose only count and safe export
  receipt metadata. Code generation itself occurs only after a new receipt has been claimed, so replay cannot mint replacement
  secrets. The Admin listener does not log payloads and its telemetry redactor recognizes the secret response field.
- List queries use HMAC-authenticated cursors bound to operator/deployment/permission scope and Site. A singleton PostgreSQL
  authority serializes low-frequency catalog publication and assigns its epoch in the writer transaction; page one captures only
  the committed epoch, later pages keep that epoch, and every response reports a separate database-clock `observedAt`.

All module ports accept only the opaque `PlatformTransaction`; no sibling module may introduce a second transaction or self-RPC.
