---
architectureIndex: 1
rootId: platform.hub.connect
owners:
  - "@LordFoxFairy"
---

# Hub private Connect runtime

## Responsibilities
Own reusable listener lifecycle, dependency-aware health/readiness, bounded shutdown and trust-root file handling for the private Hub process.

## Public API
`hub-connect-process.ts` owns listener/worker/session drain order and its bounded shutdown deadline; `hub-connect-health.ts` owns probe state; `hub-connect-secure-file.ts` is the single trust-root file reader. The sole Root-generated provider/client implementation is Platform `src/modules/hub`; the sole production entrypoint selected by `KOKORO_SERVICE_PACKAGE=platform-hub-connect` is Platform `src/process/hub-connect.ts`.

## Callers and dependencies
The exact Platform SPIFFE identity may freeze/reconcile catalogs; the exact Agent SPIFFE identity may resolve an admitted assembly and fetch skill artifacts. The process owns Mongo/package-store access and projects signed publications to Platform Admission with outbound mTLS.

## Runtime constraints
Connect traffic uses port 4252 by default and requires client certificates plus the pinned peer registry. Port 4253 is probe-only, contains no Connect routes, and is not published by the Kubernetes Service. Production requires explicit ports, Mongo, package storage, secret keyring, signing key, inbound mTLS, caller identities, and outbound projection mTLS before any listener opens. Inbound files are bounded by `KOKORO_HUB_CONNECT_TRUST_ROOT`; capability signing material by `KOKORO_HUB_CAPABILITY_SIGNING_TRUST_ROOT`; outbound Platform projection files by `KOKORO_HUB_PLATFORM_PROJECTION_TRUST_ROOT`. Mounted trust files may traverse only contained Kubernetes AtomicWriter links; final files are regular, bounded, private where required, and TOCTOU-fenced. Readiness pings Mongo and fails immediately while draining. Shutdown aborts new projection claims, sends HTTP/2 GOAWAY, waits only within the configured deadline, destroys hung sessions, and closes health plus Mongo on partial startup too.

Every RPC must advertise a positive deadline of at most 30 seconds. Twelve global/eight-per-peer
admission slots bound request memory. The production process shares one shutdown signal with worker,
assembly, package-store and stream handlers; its fixed 55-second internal drain reserves 33 seconds
for active requests and 22 seconds for forced session and Mongo cleanup.

## Extension rules
Do not add Root-generated imports or a package-local main here, add Hub HTTP routes here, merge this listener into the Hub HTTP process, or expose a new Agent-facing service. New operations must begin in the Root protobuf contract and preserve the HubRuntimeService boundary.
