---
architectureIndex: 1
rootId: service.platform.authorization
owners:
  - "@LordFoxFairy"
---

# Platform Authorization

This module owns ProductContext exchange, purpose/resource-bound SessionAccessGrant issuance, the dedicated RS256 key ring, and the signed Platform-to-Session authorization feed. The fresh production feed is the v2 `ScopedSessionAuthorizationService` ConnectRPC-over-HTTP/2 mTLS boundary. It uses rollback-safe transactional global and per-Site counters, immutable signed replacement facts, bounded frozen snapshot materialization, HMAC-bound page cursors, explicit snapshot-required recovery, and time-based retention. Session owns its cursor and local fail-closed projection; request hot paths never synchronously call Platform.

Every producer follows the same lock and commit invariant: reserve global sequence, reserve the Site sequence, mutate the exact owner, read its authoritative current row, then append the signed event in the same transaction. Site, Subject, IdentitySession, ProjectMembership, and delivered Grant facts share one contiguous feed and one frozen snapshot. Compound personal bootstrap reserves both Subject and ProjectMembership sequences before either owner mutation. Subject-, identity-, and membership-scoped changes never bump the Site revocation epoch.

SessionAccessGrant issuance reserves its `GrantDelivered` sequence before constructing claims, signs
that exact global sequence as `authorizationStreamSequence`, marks the grant delivered, and appends
the event with the same reservation in one unit of work. HTTP 201 is emitted only after that unit of
work commits; signing, delivery, or append failure rolls the reservation and pending grant back.

Production compositions mount only v2: Platform API publishes identity, personal-bootstrap and Grant changes; Admin and Worker publish Site activation and traffic-stop changes; the authorization process serves the v2 feed and verification keys to the one configured Session SPIFFE workload. Readiness fails closed on missing or inconsistent stream state. Compatibility lifecycle flags remain a root release decision and must not be promoted until the real Platform-provider/Session-consumer scenario proves positive flow plus cross-Site and neighboring-owner negative controls.

Authorization feed retention is an independent one-shot operation. It obtains a transaction-scoped PostgreSQL advisory lock before deleting snapshots or events; lock contention exits explicitly as `already-running`, and the resident worker callback never repeats the operation within one process lifetime.
