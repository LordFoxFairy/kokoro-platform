---
architectureIndex: 1
rootId: service.platform.model-gateway
owners: ["Platform Model Gateway"]
---

# Platform Model Gateway

Model Gateway is an independently deployable Platform producer. It accepts one opaque Admission-issued
`modelAuthorizationHandle`; callers cannot supply Site, account, Hold, authorization-segment, provider account, secret, or
financial amount. The dedicated PostgreSQL transaction resolves the handle through a narrow security-definer projection, sets the
resolved `app.site_id`, and uses the canonical Credit `UsageSettlementService` before any provider I/O.

The Phase-A certified surface is bounded non-streaming OpenAI chat completions with text-only system/user/assistant messages. One
authorized Gateway model maps to one LiteLLM alias. LiteLLM is only the HTTP adapter: it does not own pricing, customer spend,
business fallback, retry, model authorization, or settlement. Transport ambiguity becomes `outcome_unknown`; missing usage on a
complete terminal response becomes unavailable evidence and never an invented zero.

Each logical call has one durable invocation and one Credit attempt authorization. A changed request digest conflicts; an exact
terminal retry replays encrypted bytes without a second provider effect. Prepare commits the conservative maximum dimensions and
local prepared outbox before provider I/O. Success/failure commits canonical Credit evidence, an encrypted response envelope, a
local immutable usage fact, and terminal outbox in one Platform transaction. Response AAD binds key revision, Site, invocation and
request digest. The Gateway role cannot read the authorization projection directly and receives only exact invocation/usage/outbox
and prepare/finalize Credit privileges.

The production listener is private HTTPS with TLS 1.3 mutual authentication and an exact certificate fingerprint/SPIFFE allowlist.
Peers receive separate `invoke` and `reconcile` scopes. A provider-log owner can submit a complete response plus digest and measured
or unavailable usage to the reconciliation endpoint; only an existing `outcome_unknown` request with the exact request digest is
accepted, and it finalizes the same Credit attempt authorization at its advanced fence without redispatching the provider effect.
Startup requires a dedicated database identity, bounded owner-only response key ring, owner-only LiteLLM key file, TLS files and peer
registry. Health, readiness and drain are process-owned; shutdown stops admission, waits to a deadline, then aborts in-flight work.

Activation remains false until Root publishes the internal contract and Session/Agent deliver the opaque authorization handle plus
stable logical-call, attempt and producer-generation identities. The current GA chat factory still bypasses this entry and tool-call,
reasoning, streaming, image, music and video request/usage corpora are not certified by this Phase-A adapter. No GA graph,
checkpoint, handoff or terminal semantics belong here.

## Phase-A caller contract

`POST /internal/v1/model-invocations` accepts strict JSON containing only
`modelAuthorizationHandle`, `logicalCallRef`, `attemptRef`, `producerContext`, decimal-string
`producerGeneration`, and the typed `request`. The request is non-streaming
`openai.chat.completions.v1` with an authorized model alias, bounded text messages and
`maxOutputTokens`. The caller never sends Site or billing facts. Responses carry the raw bounded
provider JSON and `x-kokoro-model-invocation-ref`, `x-kokoro-model-attempt-ref`,
`x-kokoro-model-outcome`, and `x-kokoro-model-replayed`; `202` means durable
`outcome_unknown`, not zero usage or permission to retry the provider.

`POST /internal/v1/model-invocations/reconcile` is available only to a peer with the separate
`reconcile` scope. It binds the opaque authorization, logical-call reference and original request
digest to complete provider bytes, their SHA-256 digest, terminal outcome and measured-or-null
usage. It is an idempotent evidence callback, never a second provider dispatch endpoint.
