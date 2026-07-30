# Credit module

Credit owns Grant, append-only Journal, Hold/allocation and Usage/Rating authority. It does not expose mutable balance
adjustment APIs through its Admin read plane.

Usage attempts accept only the explicit producer identities `model_gateway`, `capability_runtime`, and `media`. `media` is a
metering producer identity for the Media product domain, not a new runtime service; there is no generic Job or Generation domain. Usage
evidence, rating snapshots, settlements, journals and command receipts are already authoritative local facts, so they are not
duplicated into an unconsumed usage-rating outbox. The separate owner=`credit` budget-operation outbox remains intact because it is
consumed by Commerce.

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
