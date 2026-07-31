# Artifact owner module

Platform owns Artifact identity, immutable versions, staged/finalized receipts and delivery authorization. Provider and
object-store locations are private infrastructure facts. Public callers receive only Artifact references and short-lived,
audience-bound delivery capabilities; redeem streams bytes through the Platform data plane with a single bounded Range.

`infrastructure/dev` contains deterministic in-memory adapters for tests and explicit local development only. Production
composition must use durable PostgreSQL authorization state and a private object-store adapter and must reject these fakes.
