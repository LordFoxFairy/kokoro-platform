---
architectureIndex: 1
rootId: service.platform.credit
owners:
  - "@LordFoxFairy"
---

# Credit module

Credit owns Grant, append-only Journal, Hold/allocation and Usage/Rating authority. It does not expose mutable balance
adjustment APIs through its Admin read plane.

Credit does not own Credit Program product truth. Program domain types, immutable catalog revisions, publication/read services,
protobuf codec, PostgreSQL catalog facts, window acquisitions, and composition belong to Commerce. Credit accepts only exact
Program snapshots through its narrow Grant issuance/correction contracts and owns the resulting Account, Grant, Hold, and Journal
facts.

`application/contracts/grant-issuance.ts` is the sole same-process grant issuance port for sibling bounded contexts. Its PostgreSQL
adapter locks the natural CreditAccount identity, returns a closed ready/unavailable result, and binds every ready capability to one
`PlatformTransaction` and one issuance. It alone creates CreditAccount, CreditGrant and the balanced issuance Journal. Scope policy
is revalidated and snapshotted at this owner boundary, and malformed, duplicate, empty-attribution or oversized policy dimensions
fail before any Credit mutation. Fulfillment replay is fenced by the caller's durable fulfillment receipt before this port is entered;
the adapter never treats a unique-constraint violation as idempotent replay.

The Platform Web Chat setup fixture has been verified against a freshly migrated PostgreSQL database. It publishes the minimum
Site-scoped compatibility Program revision through the Admin transaction, then issues the direct initial Grant through the API
transaction with `commandId=null` because no Commerce command owns that fixture operation. This setup evidence does not certify a
global paid CreditProgram catalog or recurring Credit behavior.

Recurring Commerce enrollments use the same port with `source_type=program_window` and a non-empty immutable
`source_window_key`. Permanent acquisition grants require the empty window key. Credit persists that key in the Grant uniqueness
fence; Commerce owns enrollment and absolute window acquisition facts, while Credit still owns Grant and Journal materialization.

`CreditService` is also the only authority for deriving and returning a Media child allocation inside an existing GA execution
budget root. `deriveChildAllocation` locks the exact Site/root/root-allocation head, fences the expected revision and epoch, protects
already-reserved Segment capacity, and atomically moves exact stock from parent `unassignedStock` to
`activeChildReservedStock`. The immutable child is audience=`media`, purpose=`media_operation`, and binds the Media operation,
consumption scope, expiry, initial revision, reservation receipt, and stable command digest. `returnChildAllocation` requires exact
parent/child fences plus Media-owned terminal evidence; it fails closed for reserved, committed, rating-pending, reconciliation, or
descendant work, then atomically terminals the child, rolls captured and unspent stock into the parent, and records the return and
operation receipts. Same command plus same digest replays the persisted result; a changed digest conflicts without another child or
second return.

All Credit financial mutations use one lock order: allocation rows in UUID order, then the exact execution budget root, then the
exact Hold named by that root. Mutable revision, root, Hold, Segment, and prior-return facts are fresh-loaded only after those locks.
Derive, return, Usage settlement, and reconciliation share this order rather than relying on a multi-relation `FOR UPDATE` plan.
Journal entry digests have one pure domain codec in `domain/journal-digest.ts`; reservation, capture, release, grant issuance and
execution-root closure all use the same UTF-8 byte-length framing that PostgreSQL verifies at deferred commit.

This pre-release Media child schema is a fresh-data hard cut. Its first migration operation rejects legacy audience=`job` allocations
or any pre-existing allocation reservation/return receipts with
`CREDIT_MEDIA_CHILD_MIGRATION_REQUIRES_FRESH_DATA`; development data must be reset. There is deliberately no legacy migration,
backfill, reason recovery, row deletion, or temporary immutable-trigger disable path.

The typed `RunBudgetAuthority` is wired into Media image submission through the native same-transaction owner. Direct Studio
reserves and commits its root Segment; an Agent operation derives its exact child allocation and then commits a distinct
child-owned Segment. Media never writes Credit tables. At terminalization, Credit resolves only pre-issued attempt authority,
rates the exact certified evidence set and returns the Agent child through fresh parent/child revision and epoch fences. Missing or
ambiguous usage enters reconciliation rather than being priced as zero. The direct-root terminal authority and its production
composition, including canonical upstream evidence, remain fail-closed launch blockers; see
`docs/platform/media-worker-launch-blockers.md`. The implemented direct-root
owner accepts only a live Media task lease, locks authoritative Media/Rating/Credit facts, verifies the frozen admission budget and
evolved settlement closure separately, and closes the root through closed bounded definer commands. PostgreSQL independently
recomputes request, closure-receipt and release-journal digests; reconciliation cannot regress terminal facts or reuse a receipt UUID
as an allocation revision UUID.

`ExecutionRootClosureAuthority` is the source-neutral Credit policy for terminal root, root-allocation and Hold conservation.
It decides from locked Credit and Rating facts only: source-specific terminal proof, receipt encoding and database fencing stay in
adapters. The Media adapter maps that one decision into its existing worker-lease and security-definer protocol; it does not own a
second release planner. Agent/Admission integration must use this same authority rather than introduce another financial mutation.
The allocation-revision insert trigger alone advances the mutable allocation head. Atomic `open` to `settled` Root/Hold edges are
accepted only inside the exact closure security-definer call, under a transaction-local marker and effective-user/table-owner fence;
raw Admission or Media updates remain rejected even when a caller spoofs the marker.

The Postgres repository reuses the branded
`PlatformTransaction`, existing allocation lineage/conservation triggers, reservation/return receipt tables, and local operation
receipts. Child allocation commands do not emit an outbox event because no routed consumer exists for those events. The repository
performs no network I/O and creates no Media balance, ledger, job, generation, or queue authority. Persisted allocation and command
receipt rows are rehydrated with closed runtime validation; corrupt stock, terminal lineage, result keys, digests, or receipt scope
fail closed.

Canonical Media child receipt builders own both digest construction and persisted JSON parsing. Public receipts return the allocation,
revision, epoch, scope, closure, and observed facts; internal digest payloads additionally bind Site, operation kind, business key, and
request digest without leaking those command fields into the returned receipt. The latest terminal return lookup is backed by
`credit_budget_operation_receipt_return_child_latest_idx` on
`(site_ref,child_allocation_ref,completed_at DESC) WHERE operation_kind='return_media_child'`. On a leased component database, verify
planner alignment with `SET LOCAL enable_seqscan=off; EXPLAIN (COSTS OFF) SELECT result FROM
platform.credit_budget_operation_receipt WHERE site_ref=$1 AND child_allocation_ref=$2::uuid AND
operation_kind='return_media_child' ORDER BY completed_at DESC LIMIT 1;`.

Usage attempts accept only the explicit producer identities `model_gateway`, `capability_runtime`, and `media`. `media` is a
metering producer identity for the Media product domain, not a new runtime service; there is no generic Job or Generation domain. Usage
evidence, rating snapshots, settlements, journals and command receipts are already authoritative local facts, so they are not
duplicated into an unconsumed usage-rating outbox. The separate owner=`credit` budget-operation outbox remains intact because it is
consumed by Commerce.

Usage producers and the settlement owner share one transaction-scoped advisory fence per Site/Segment. Producer prepare/finalize
loads Segment, allocation, Root, Hold and latest evidence through plain `SELECT` under that fence, so producer roles need no UPDATE
privilege on Credit financial or evidence tables. Settlement keeps the existing Root/Hold/Segment row locks and CAS mutations after
acquiring the same fence; each non-zero settlement capture also advances the Hold fence exactly once from the locked epoch, as
required by the immutable Hold transition guard. Credit segment mutation commands use that fence as well.

`interfaces/connect/admin-credit-service.ts` is the dedicated typed operator provider. Every request resolves an exact Site
through the shared Admin control plane and every database read uses `adminSiteQueryTransaction`, which sets the same exact Site
for PostgreSQL RLS. Pagination tokens are HMAC-authenticated and bind the verified operator generation, security,
authorization and scope epochs plus Site, list kind and exact filters. A source identity is always the pair
`(source_type, source_ref)`; neither half is accepted alone.

`infrastructure/postgres/admin-credit-reader.ts` reads authority facts directly. Site/account balances are derived in the same
database transaction and labelled with `freshness` plus `as_of`; they remain read models, never replacement authority. Every
list captures its first-page `membershipWatermark` from PostgreSQL `transaction_timestamp()` and carries it across later pages;
`observedAt` independently reports when the current page transaction ran. Hold allocation reads work in both Hold-to-Grant and
Grant-to-Hold directions. RatedUsage source allocations preserve settlement-to-Grant direction and amount. The provider exposes
normalized source/execution references, decimal strings and complete aggregate counts, but never raw evidence, rating snapshots,
provider payloads, secrets, or legal-liability dimensions.
