---
architectureIndex: 1
rootId: platform.hub.connect-adapters
owners:
  - "@LordFoxFairy"
---

# Hub Connect contract adapters

## Responsibilities

Adapt the repository's single Root-generated Hub protobuf tree to Hub-owned catalog/application ports, and deliver signed capability projections to Platform Admission.

## Public boundary

`interfaces/connect` contains the generated-service providers and runtime registration. Its inbound
Agent/Hub deadline is a fixed 30-second maximum and is not runtime-configurable; an advertised
30,001 ms deadline or a request without an explicit positive deadline is rejected before dispatch.
The listener admits at most twelve concurrent RPCs and eight per pinned peer. Handler cancellation
is passed through assembly resolution, package-store reads and every artifact chunk.
`infrastructure/connect` contains the outbound
Platform projection client. `src/process/hub-connect.ts` is the only production composition and
process entrypoint.

## Ownership boundary

Business rules, Mongo/S3 persistence, package assembly, worker behavior, health state and shutdown mechanics remain owned by `@kokoro/hub`. These adapters depend only on that package's explicit public exports; they do not read Hub private files or duplicate its persistence contracts.

## Extension rules

Generate contracts only into `src/generated`. Do not recreate a package-local generated tree, provider, client, main or fallback. Root contract changes must update these adapters and their deployment guard in the same change.
