---
architectureIndex: 1
rootId: platform.litellm
owners:
  - "@LordFoxFairy"
---

# LiteLLM deployment adapter

## Responsibilities
Provide the optional OpenAI-compatible LiteLLM adapter configuration examples, health checks, and local smoke commands.

## Non-responsibilities
This directory does not own model catalog, routing authorization, pricing, credit settlement, or provider secrets.

## Public boundary
`config/`, `scripts/healthcheck.sh`, `scripts/smoke-openai-compatible.sh`, and documented remote HTTP behavior form the boundary.

## Callers and dependencies
Root Infra may explicitly deploy this adapter. Platform Model Gateway is its only Kokoro runtime caller;
Agent always calls Platform Model Gateway.

## Data ownership and events
LiteLLM owns transient proxy state only; Platform owns model/provider configuration and usage facts.

## Runtime and security
Real keys and TLS material are environment/secret-manager supplied. The server certificate SAN includes the `litellm` service DNS
name, callers trust its dedicated CA, and the exported runtime base is HTTPS `/v1`. Example files contain fake values and
responses/logs must not leak provider credentials.

## Idempotency, failure, and recovery
Health and smoke checks are repeatable. Retries stay inside the selected authorization and preserve the
stable logical-call identity. A failed LiteLLM attempt has no adapter fallback.

## Extension rules and forbidden dependencies
Keep deployment adapter configuration here; Model Gateway owns invocation and business integration, and no business policy belongs in LiteLLM YAML.

## Current gotchas
Root's default Compose `full` profile and Kubernetes Base are Direct-only. This adapter exists only in
the explicit Compose `model` profile or Kubernetes LiteLLM overlay. Model Control publishes
`adapterKind: direct | litellm`; the Platform Model Gateway consumes this adapter for authorized
streaming text chat, tools, and reasoning deltas. Image, music, and video generation use separate
certified adapters and remain outside this LiteLLM chat surface.

## Verification
Run the health/smoke scripts only against an explicitly provisioned test endpoint, plus Root model-gateway compatibility tests.
