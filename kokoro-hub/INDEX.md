---
architectureIndex: 1
rootId: platform.hub
owners:
  - "@LordFoxFairy"
---

# Capability Hub module

## Responsibilities
Own Skill/MCP catalog administration, revisions, enablement, package metadata, uploads, and operator-facing capability workflows.

## Non-responsibilities
Hub does not execute Agent tools, own GA graph nodes, or sit on every-run capability assembly hot paths.

## Public boundary
`src/interfaces/http` and `src/interfaces/admin` expose the module; package/storage contracts live under `src/contract` and application ports.

## Callers and dependencies
Admin and Platform orchestration write through Hub. Agent runtime consumes immutable grants/snapshots through its declared read boundary.

Hub calls `kokoro-user` at `GET /memberships/check` to authorize `self` requests, and binds that response through `@kokoro/user/contract` rather than a local copy of the shape — a rename on the provider now fails this package's typecheck instead of surfacing as a runtime parse error. The import is the narrow contract entry, so none of user's Prisma/Fastify/mail stack is pulled in. This is the only edge Hub has beyond `platform.kit`, and it makes an existing wire dependency visible to the dependency gate rather than leaving it implicit.

## Data ownership and events
Hub owns capability catalog/revision metadata and package references in Mongo/S3-compatible storage.

## Runtime and security
Uploads require validation, content addressing, bounded size/path rules, trusted operator context, and secret-free metadata.

## Idempotency, failure, and recovery
Revision/CAS and content hashes handle duplicate publication; package-first metadata-second writes prevent dangling live references.

## Extension rules and forbidden dependencies
Add new capability kinds only through the approved closed registry. Do not model DeepAgents internal graph nodes as catalog capabilities.

## Current gotchas
V1 capability kind is limited to Skill and MCP; later runtime grants must preserve GA's opaque namespace boundary.

## Verification
Run `pnpm --filter @kokoro/hub test`, typecheck/lint, and Mongo/MinIO-backed integration tests.
