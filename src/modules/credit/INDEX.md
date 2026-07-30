# Credit module

Credit owns Grant, append-only Journal, Hold/allocation and Usage/Rating authority. It does not expose mutable balance
adjustment APIs through its Admin read plane.

`interfaces/connect/admin-credit-service.ts` is the dedicated typed operator provider. Every request resolves an exact Site
through the shared Admin control plane and every database read uses `adminSiteQueryTransaction`, which sets the same exact Site
for PostgreSQL RLS. Pagination tokens are HMAC-authenticated and bound to operator permit, Site, list kind and filters.

`infrastructure/postgres/admin-credit-reader.ts` reads authority facts directly. Site/account balances are derived in the same
transaction snapshot and labelled with `freshness` plus `as_of`; they remain read models, never replacement authority. The
provider exposes normalized source/execution references, decimal strings and safe counts, but never raw evidence, rating
snapshots, provider payloads, secrets, or legal-liability dimensions.
