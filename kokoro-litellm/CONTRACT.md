# kokoro-litellm Contract

`kokoro-litellm` is the optional LiteLLM adapter deployment package behind Platform Model Gateway. It
is not a Kokoro business service, the default production adapter, or a business-data owner.

## Ownership

Owns:

- LiteLLM runtime configuration examples.
- Docker Compose example for local gateway startup.
- Health and OpenAI-compatible smoke scripts.
- Gateway runbook and environment template.

Does not own:

- Model catalog authority.
- Provider account lifecycle.
- Model binding lifecycle.
- Site/team/user permissions.
- Credit pricing, holds, ledger entries, or usage records.
- Payment or refund state.
- Platform Model Gateway's Direct adapter.

## Cross-Module Contract

Platform Model Control is the business authority for model availability and publishes the adapter
choice. Admission freezes that choice into the execution authorization.

```text
adapterKind: direct | litellm
gatewayModel = stable Model Gateway alias
adapterKind: litellm => gatewayModel = LiteLLM model_list[].model_name
```

Agent calls only Platform Model Gateway with the stable alias and opaque authorization handle. It does
not call LiteLLM, choose adapters, receive provider-model mappings, or settle usage. Platform Model
Gateway resolves the frozen authorization and invokes this endpoint only for `adapterKind: litellm`.

## Request Flow

```text
Agent
  -> Platform Model Gateway (gatewayModel + opaque authorization handle)
  -> execution authorization resolver (frozen adapterKind)
  -> LiteLLM HTTPS /v1 (only when adapterKind is litellm)
  -> Platform-owned usage and credit settlement
```

LiteLLM can provide proxy-local retries, virtual keys, rate limits, and budget guardrails inside the
already selected adapter. Platform owns model authorization, logical-call identity, final usage facts,
and the credit ledger.

## Configuration Rules

- `model_list[].model_name` is a stable gateway name, not a display label.
- Provider keys must be referenced through environment variables.
- Example files must not contain real secrets.
- Pricing and entitlement rules must not be stored in LiteLLM config.
- Site/team/user authorization must not be stored in LiteLLM config.
- Adapter selection and fallback rules must not be stored in LiteLLM config.
- Production deploys should pin `LITELLM_IMAGE` to a concrete tag or digest.
- The Model Gateway consumes an HTTPS `/v1` base. LiteLLM terminates TLS with
  `--ssl_keyfile_path`/`--ssl_certfile_path`; callers trust the dedicated CA and append operation paths.

## Failure Semantics

- Missing LiteLLM configuration, an unavailable endpoint, or provider failure fails the selected
  attempt; there is no adapter fallback to Direct or a different model.
- Proxy-local retries must preserve the Platform logical-call identity and stay within the authorized
  adapter/model mapping.
- If LiteLLM spend tracking disagrees with Kokoro usage records, Kokoro credit ledger remains the source of truth and the mismatch becomes an operations alert.
