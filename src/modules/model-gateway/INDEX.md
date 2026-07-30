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

The certified surface is resumable streaming chat with typed system/user/assistant/tool messages, function definitions,
tool choice and tool-call identity/arguments. One authorized Gateway model maps to one LiteLLM alias. LiteLLM is only the outbound
HTTP adapter: it does not own pricing, customer spend, business fallback, retry, model authorization, or settlement. Transport
ambiguity becomes `outcome_unknown`; missing usage on a complete terminal response becomes unavailable evidence and never an
invented zero.

Each logical call has one durable invocation and one Credit attempt authorization. A changed request digest conflicts; an exact
retry attaches to the same invocation and resumes after a caller-supplied frame sequence without a second provider effect. Prepare
commits the conservative maximum dimensions, encrypted request journal and accepted frame before provider I/O. Provider deltas and
terminal results are encrypted immutable frames with a canonical sequence/digest chain. Success/failure commits canonical Credit
evidence, the encrypted terminal response, a local immutable usage fact and terminal outbox in one Platform transaction. Response
AAD binds key revision, Site, invocation and request digest. The Gateway role cannot read the authorization projection directly and
receives only exact invocation/frame/usage/outbox and prepare/finalize Credit privileges.

Dispatch is a durable queued-to-owner-fenced state machine with leases, heartbeats, bounded active/queued capacity and a recovery
scanner. Stream readers tail committed frames through one process-level PostgreSQL `LISTEN` connection; transactional `NOTIFY`
wakes matching readers, while a bounded rescan preserves correctness across disconnects or lost notifications. There is no
transaction-per-client busy poll. The unary `InvokeModel` API aggregates this same streaming engine rather than maintaining a second
provider path.

The production listener is private HTTP/2 ConnectRPC over TLS 1.3 mutual authentication and an exact certificate
fingerprint/SPIFFE allowlist. Only the configured GA SPIFFE identity may invoke the RPC. Trusted provider reconciliation remains an
internal application/worker path; it is deliberately not caller-accessible. It can finalize only an existing `outcome_unknown`
invocation at the same Credit fence and never redispatches the provider effect. Startup requires a dedicated database identity,
bounded owner-only response key ring, owner-only LiteLLM key file, TLS files and peer registry. Health, readiness and drain are
process-owned; shutdown stops admission, waits to a deadline, then aborts in-flight work.

Admission mints the opaque authorization handle, places it inside the sealed RunRequest and binds it into the execution-manifest
digest. GA supplies that handle plus stable logical-call, attempt and producer-generation identities. Image, music and video
generation use their own product routes and generation adapters; they must not be smuggled through the chat corpus. No GA graph,
checkpoint, handoff or terminal semantics belong
here.

## Caller contract

`kokoro.platform.model.v1.ModelGatewayService/StreamModel` and `InvokeModel` accept only the opaque authorization handle, stable call
identities and the typed request. The caller never sends Site, account, Hold, price, provider account or secret facts. Every stream
frame repeats the immutable invocation/attempt identity and carries its sequence, previous digest and canonical digest. The Agent
consumer must validate all of those fields and reject gaps, digest mismatches and frames after a terminal. Successful terminal
frames are a safe typed projection of content, reasoning, tool calls and usage; failed frames contain only a stable code and
retryability; durable `outcome_unknown` carries no provider detail and is never permission to dispatch a new attempt.
