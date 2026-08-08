---
architectureIndex: 1
rootId: service.platform.media.application
owners:
  - "@LordFoxFairy"
---

# Media application boundary

Application code coordinates Media use cases and owns outbound ports. The Root-generated request canonicalizer implements
`MediaDefinitionCanonicalizer`; adapters return the opaque value produced by `canonicalMediaRequest`, so neither the adapter's
source buffer nor a caller's returned byte copy can mutate the bytes bound to its fingerprint. Shared-memory and Proxy-backed byte
views are not valid canonicalization results.
