---
architectureIndex: 1
rootId: service.platform.model-gateway
owners:
  - "@LordFoxFairy"
---

# Platform Model Gateway

Model Gateway is an independently deployable Platform producer. It accepts one opaque Admission-issued
`modelAuthorizationHandle`; callers cannot supply Site, account, Hold, authorization-segment, provider account, secret, or
financial amount. The dedicated PostgreSQL transaction resolves the handle through a narrow security-definer projection, sets the
resolved `app.site_id`, and uses the canonical Credit `UsageSettlementService` before any provider I/O.
Chat usage dimensions use Credit's canonical source unit `token` for both conservative maximum authorization and
provider-reported `input_tokens`/`output_tokens`; adapters must not pluralize or normalize this value independently.

The certified surface is resumable streaming chat with typed system/user/assistant/tool messages, function definitions,
tool choice and tool-call identity/arguments. Admission freezes one exact route containing `adapter_kind`, `gateway_model`, and
`provider_model`; all three fields are bound into the execution-manifest digest and resolved from the opaque authorization handle.
The provider router rejects a request whose model differs from the frozen Gateway alias, then selects exactly `direct` or
`litellm`. It never falls back to the other adapter. Direct sends the frozen provider model, while LiteLLM sends the frozen Gateway
alias. Neither outbound OpenAI-compatible adapter owns pricing, customer spend, business retry, model authorization, or settlement.
Transport ambiguity becomes `outcome_unknown`; missing usage on a complete terminal response becomes unavailable evidence and
never an invented zero.

Each logical call has one durable invocation and one Credit attempt authorization. A changed request digest conflicts; an exact
retry attaches to the same invocation and resumes after a caller-supplied frame sequence without a second provider effect. Prepare
commits the conservative maximum dimensions, encrypted request journal and accepted frame before provider I/O. Provider deltas and
terminal results are encrypted immutable frames with a canonical sequence/digest chain. Success/failure commits canonical Credit
evidence, the encrypted terminal response, a local immutable usage fact and terminal outbox in one Platform transaction. Response
AAD binds key revision, Site, invocation and request digest. The Gateway role cannot read the authorization projection directly and
receives only exact invocation/frame/usage/outbox and prepare/finalize Credit privileges.
The shared outbox enables PostgreSQL RLS: the Gateway can insert only owner `credit-usage-rating`, cannot read or update generic
outbox rows, and fails startup unless FORCE RLS and the complete canonical policy inventory are active. `credit-usage-rating` is
currently producer-only: no deployed worker claims or completes it until the rating-consumer business owner and effect contract
are explicitly decided; the aggregate worker allowlist intentionally excludes it.

The Platform Web Chat fixture's setup-to-observe stage has been verified against a freshly migrated PostgreSQL database. Its
fixture-observer identity receives bounded read access to the exact Gateway and Credit evidence relations; before a Model call, all
invocation, attempt, evidence and settlement counts are expected to remain zero. This stage verifies setup and observer authority,
not the later Gateway-to-selected-provider runtime hop. The fixture defaults
`PLATFORM_FIXTURE_MODEL_PROVIDER` to `direct`; `litellm` must be selected explicitly, and any other value fails before model
inventory preparation without falling back to another adapter.

Dispatch is a durable queued-to-owner-fenced state machine with leases, heartbeats, bounded active/queued capacity and a recovery
scanner. Stream readers tail committed frames through one process-level PostgreSQL `LISTEN` connection; transactional `NOTIFY`
wakes matching readers, while a bounded rescan preserves correctness across disconnects or lost notifications. There is no
transaction-per-client busy poll. The unary `InvokeModel` API aggregates this same streaming engine rather than maintaining a second
provider path. The Gateway role receives only INSERT, fenced mutation columns, and SELECT on the five queue identity/fence columns
that PostgreSQL must evaluate for those mutations; it has no table-level queue SELECT or access to queued authorization payloads.

After the provider emits one terminal, the dispatch stays active until that exact terminal is durable or process shutdown begins.
A non-committed success/failure finalization error immediately switches to one stable, message-free owner-evidence reference and an
`outcome_unknown` terminalization attempt. Terminalization-only retries start at 100 ms and double to a 2-second maximum delay;
they never re-enter adapter selection or provider streaming. The owner keeps renewing its durable dispatch lease throughout these
retries, so same-process and independent maintenance scanners cannot replace live terminalization evidence with expired-owner
evidence. A commit-ambiguous finalize/unknown retry first observes the durable invocation, replays its original terminal, and cannot
append a second terminal frame. If shutdown wins while storage remains unavailable, restart maintenance marks the expired dispatch
`outcome_unknown` without preparing or invoking any provider.

The production listener is private HTTP/2 ConnectRPC over TLS 1.3 mutual authentication and an exact certificate
fingerprint/SPIFFE allowlist. Only the configured GA SPIFFE identity may invoke the RPC. Trusted provider reconciliation remains an
internal application/worker path; it is deliberately not caller-accessible. It can finalize only an existing `outcome_unknown`
invocation at the same Credit fence and never redispatches the provider effect. Startup requires a dedicated database identity,
bounded owner-only response key ring, TLS files, peer registry, and a complete Direct endpoint/key pair on every production start.
LiteLLM is installed only when its endpoint and key file are both explicitly present; a partial pair fails startup, and it never
replaces the required Direct baseline. Health, readiness and drain are process-owned; shutdown stops
admission, waits to a deadline, then aborts in-flight work.

The one required Direct adapter owns the MVP's single runtime credential. ModelControl's fixed `direct`/`primary` inventory identity
and runtime-managed secret marker identify that slot but contain no secret and are not additional deployment settings. Multiple
logical models and upstream model names may bind to the same Direct credential. No health reporter is required to make this
baseline selectable: Direct alone may start at `unknown`; optional LiteLLM remains ineligible until explicitly healthy or degraded.

Admission mints the opaque authorization handle, places it inside the sealed RunRequest and binds it into the execution-manifest
digest. GA supplies that handle plus stable logical-call, attempt and producer-generation identities. Image, music and video
generation use their own product routes and generation adapters; they must not be smuggled through the chat corpus. No GA graph,
checkpoint, handoff or terminal semantics belong
here.

Image effects are a separate private Media-to-Gateway owner surface across the module's existing DDD layers; they do not reuse the
chat invocation or OpenAI-compatible chat adapters. The application freezes the exact model
option/deployment/input/output-slot authorization, atomically consumes a
signed local budget commit and journals a planned attempt before any Provider I/O. Public recovery and cancellation read only
stable references, digests and encrypted-envelope metadata. Only the separately authenticated cross-Site image worker may claim a
lease and briefly unseal source grants; the owned plaintext buffer is zeroized after the certified provider adapter has consumed
it. Provider events are ordered and digest-idempotent, ambiguity never authorizes a blind retry, and a next attempt requires the
exact definitely-not-submitted receipt for its predecessor.

This image surface is currently production-disabled and startup fails closed if it is requested. Activation requires all of the
following Root-owned pieces to be generated and pinned together: known-field Create/Cancel/Attach effect digests, bounded owner
evidence/output retrieval, signed budget-commit verification/materialization, and a certified Provider protocol/adapter. Platform
does not synthesize any of those contracts or register a development fake in production.

Evidence reads remain immutable and never mint or return a source/provider bearer. Output delivery requires its own Issue/Recover
command journal and a bounded read capability stream; that owner is intentionally not approximated by the current effect journal
or by `GetImageEffectEvidence`.

## Caller contract

`kokoro.platform.model.v1.ModelGatewayService/StreamModel` and `InvokeModel` accept only the opaque authorization handle, stable call
identities and the typed request. The caller never sends Site, account, Hold, price, provider account or secret facts. Every stream
frame repeats the immutable invocation/attempt identity and carries its sequence, previous digest and canonical digest. The Agent
consumer must validate all of those fields and reject gaps, digest mismatches and frames after a terminal. Successful terminal
frames are a safe typed projection of content, reasoning, tool calls and usage; failed frames contain only a stable code and
retryability; durable `outcome_unknown` carries no provider detail and is never permission to dispatch a new attempt.
