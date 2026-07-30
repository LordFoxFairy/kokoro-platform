---
architectureIndex: 1
rootId: service.platform
owners:
  - "@LordFoxFairy"
---

# Kokoro Platform

## Current production architecture

The root Prisma 7/PostgreSQL implementation is the only Platform business authority. Site, identity, authorization, policy,
model control, credit/usage, commerce redemption, assets, Admission and privileged Admin all live in this source tree and share
one migration authority. API, worker, Admission, Authorization, Asset Data Plane, Model Gateway, Admin and Migrator remain
independently selectable processes with exact database credential classes. PostgreSQL RLS, security-definer projections and
process-specific grants enforce the internal boundaries; there is no MySQL authority mode, dual write or legacy cutover path.

## Responsibilities

Own shared Site, identity, model-control, credit, commerce, capability, and privileged Admin business facts in a modular TypeScript service repository.

## Non-responsibilities

Platform does not execute Agent graphs, own Session messages/SSE, render Site Web applications, or absorb child repository lifecycles.

## Public boundary

Ordinary Site product traffic uses the bounded public HTTP/JSON BFF contract. Privileged control planes use Root-owned
Protobuf/Connect contracts: Admin Identity/Auth/Query/Commerce, Session Admission and Asset Eligibility, Hub capability
publication/runtime, and Agent Model Gateway. Same-Platform bounded contexts never self-RPC; application ports and one scoped
transaction coordinate local owners. Root `src/index.ts` exposes only the Platform composition surface, and
`deploy/docker/Dockerfile` builds the closed runtime artifact.

## Callers and dependencies

Web Admin calls the Admin gateway's `/api/*` endpoints and the generated Admin Auth Connect service; Session consumes versioned internal APIs; Agent reaches model/capability backends only through approved runtime protocols.

## Data ownership and events

Each module owns its schema/migrations and domain events. Cross-module orchestration must use application ports and an explicit Platform transaction boundary.

## Runtime and security

Every request resolves trusted workload and Site context before business use. Secrets remain environment/secret-manager owned and private tables are never cross-service APIs.

## Idempotency, failure, and recovery

Effect commands use durable receipts, stable idempotency keys, transactional writes, and reconciliation after ambiguous timeouts.

## Extension rules and forbidden dependencies

Keep domain/application independent of transport and persistence. Add deployable adapters inside the owning module; do not create a new Git repository solely for directory separation.

## Current gotchas

General Admission is the only constructor of sealed GA execution material and the owner of Site/model/capability/asset/credit
admission decisions. Model Gateway owns resumable chat provider effects, encrypted frame journals, Credit evidence and LiteLLM
adaptation; Agent consumes only the opaque authorization and verifies the frame digest chain. Image, music and video generation
must use dedicated product/generation routes instead of expanding the chat corpus. Payment provider connectors may remain disabled
per Site; card redemption reaches the same Commerce fulfillment and Credit grant path as a successful purchase.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and dependency-backed `pnpm test:integration` before release.
