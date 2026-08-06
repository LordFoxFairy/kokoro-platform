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

`interfaces/connect` contains the generated-service providers and runtime registration. `infrastructure/connect` contains the outbound Platform projection client. `src/process/hub-connect.ts` is the only production composition and process entrypoint.

## Ownership boundary

Business rules, Mongo/S3 persistence, package assembly, worker behavior, health state and shutdown mechanics remain owned by `@kokoro/hub`. These adapters depend only on that package's explicit public exports; they do not read Hub private files or duplicate its persistence contracts.

## Extension rules

Generate contracts only into `src/generated`. Do not recreate a package-local generated tree, provider, client, main or fallback. Root contract changes must update these adapters and their deployment guard in the same change.
