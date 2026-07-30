---
architectureIndex: 1
rootId: platform.hub.connect
owners:
  - "@LordFoxFairy"
---

# Hub private Connect runtime

## Responsibilities
Expose Root-generated `HubCatalogService` and `HubRuntimeService` over one private HTTP/2 listener and publish dependency-aware liveness/readiness over a separate probe listener.

## Public API
`main.ts#runHubConnectMain` is the production process entrypoint selected by `KOKORO_SERVICE_PACKAGE=platform-hub-connect`. `capability-catalog-services.ts` is the only Connect service implementation surface. `hub-connect-process.ts` owns listener/worker/session drain order and its bounded shutdown deadline; `hub-connect-secure-file.ts` is the single trust-root file reader.

## Callers and dependencies
The exact Platform SPIFFE identity may freeze/reconcile catalogs; the exact Agent SPIFFE identity may resolve an admitted assembly and fetch skill artifacts. The process owns Mongo/package-store access and projects signed publications to Platform Admission with outbound mTLS.

## Runtime constraints
Connect traffic uses port 4252 by default and requires client certificates plus the pinned peer registry. Port 4253 is probe-only, contains no Connect routes, and is not published by the Kubernetes Service. Production requires explicit ports, Mongo, package storage, secret keyring, signing key, inbound mTLS, caller identities, and outbound projection mTLS before any listener opens. Mounted trust files may traverse only bounded Kubernetes AtomicWriter links contained by `KOKORO_HUB_CONNECT_TRUST_ROOT`; final files are regular, bounded, private where required, and TOCTOU-fenced. Readiness pings Mongo and fails immediately while draining. Shutdown aborts new projection claims, sends HTTP/2 GOAWAY, waits only within the configured deadline, destroys hung sessions, and closes health plus Mongo on partial startup too.

## Extension rules
Do not add Hub HTTP routes here, merge this listener into the Hub HTTP process, or expose a new Agent-facing service. New operations must begin in the Root protobuf contract and preserve the HubRuntimeService boundary.
