# Identity module

Identity owns public account, authentication, verification, security-management and personal bootstrap facts inside the Platform
PostgreSQL authority. It coordinates sibling Platform contexts through application ports and the shared `PlatformUnitOfWork`; it
does not call the Platform deployment over HTTP or RPC.

## Durable effects

- Identity emits only sealed `identity.verification.delivery.requested` and typed
  `identity.namespace.allocation.requested` effects under outbox owner `identity`.
- Verification delivery is the only remote effect. The worker accepts only an `A256GCM` envelope, validates its keyed audit
  digest, and forwards it to the configured HTTPS provider using the outbox event id as the stable provider idempotency key.
  Requests and acknowledgements are HMAC authenticated. Plaintext verification material never enters the outbox, result tables,
  logs, errors or metrics.
- Every sealed payload and owner delivery row carries the verification credential revision. Dispatch first transitions that exact
  revision to `dispatching`; resend locks the same delivery rows and therefore either supersedes an older queued revision or fails
  while a provider effect is in flight. A superseded event is recorded and completed atomically without calling the provider or
  entering retry/dead-letter.
- A provider acknowledgement is followed by one short transaction that updates
  `identity_verification_delivery` and completes the shared outbox lease. If that transaction has an ambiguous outcome, the lease
  is left for an idempotent provider replay; the worker never invents success.
- A timeout or stream reset while reading a successful provider acknowledgement is also `outcome_unknown`: the event remains
  retryable with the same event id. Only a complete, bounded but invalid acknowledgement is classified as a permanent protocol
  failure.
- Namespace allocation is a local Identity projection, not a remote job or self-RPC. The worker validates the complete personal
  bootstrap graph and atomically activates `identity_namespace_allocation_intent` plus `identity_execution_space` while completing
  the outbox event. Admission remains fail-closed unless both owner projections are committed.
- Retry, dead-letter, lease heartbeat and shutdown lease return reuse the shared outbox implementation. The worker claims exactly
  owner `identity` and the two event types above. Lease renewal is fenced by event, token, stable worker instance id and owner;
  Kubernetes injects the Pod UID and Compose requires an explicit instance id.

## Runtime authority

`platform-worker` receives only the Identity projection columns required to validate these effects and exact outcome update
columns. Startup and post-migration authority checks positively prove those grants and prove that verification digest/email columns
are unreadable. Delivery endpoint, HMAC secret file, audit-digest key file and their immutable trust root are mandatory production
configuration; startup fails before claiming work when any is missing or unsafe. Kubernetes AtomicWriter symlinks may resolve only
inside that root, and the final group-readable file is opened no-follow and checked through one stable descriptor.
