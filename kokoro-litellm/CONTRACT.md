# kokoro-litellm Contract

`kokoro-litellm` is the external LiteLLM gateway configuration package for Kokoro. It is not a Kokoro business service and does not own business data.

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
- Direct adapters for non-LLM providers.

## Cross-Module Contract

`kokoro-model` is the business authority for model availability.

```text
ModelBinding.transportKind = litellm
ModelBinding.gatewayModelName = LiteLLM model_list[].model_name
```

Runtime callers must resolve models through `kokoro-model` first. They should not hard-code provider model names from the LiteLLM config.

## Request Flow

```text
runtime
  -> kokoro-model resolve
  -> kokoro-credit quote
  -> kokoro-credit hold
  -> LiteLLM OpenAI-compatible endpoint
  -> kokoro-credit capture or release
  -> kokoro-credit usage record
```

LiteLLM can provide provider proxying, virtual keys, retries, rate limits, and budget guardrails. Kokoro still owns the final credit ledger and usage audit.

## Configuration Rules

- `model_list[].model_name` is a stable gateway name, not a display label.
- Provider keys must be referenced through environment variables.
- Example files must not contain real secrets.
- Pricing and entitlement rules must not be stored in LiteLLM config.
- Site/team/user authorization must not be stored in LiteLLM config.
- Production deploys should pin `LITELLM_IMAGE` to a concrete tag or digest.

## Failure Semantics

- If LiteLLM is down, runtime should release or expire any active credit hold according to the caller workflow.
- If LiteLLM returns provider errors, runtime should use the resolved fallback order from `kokoro-model`; LiteLLM retries are an additional guard, not the business fallback authority.
- If LiteLLM spend tracking disagrees with Kokoro usage records, Kokoro credit ledger remains the source of truth and the mismatch becomes an operations alert.
