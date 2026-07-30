---
architectureIndex: 1
rootId: platform.litellm
owners:
  - "@LordFoxFairy"
---

# LiteLLM deployment adapter

## Responsibilities
Provide current OpenAI-compatible LiteLLM configuration examples, health checks, and local smoke commands.

## Non-responsibilities
This directory does not own model catalog, routing authorization, pricing, credit settlement, or provider secrets.

## Public boundary
`config/`, `scripts/healthcheck.sh`, `scripts/smoke-openai-compatible.sh`, and documented remote HTTP behavior form the boundary.

## Callers and dependencies
Root Infra may deploy this adapter; Agent/Model Gateway call its versioned HTTP endpoint rather than importing files.

## Data ownership and events
LiteLLM owns transient proxy state only; Platform owns model/provider configuration and usage facts.

## Runtime and security
Real keys are environment/secret-manager supplied. Example files contain fake values and responses/logs must not leak provider credentials.

## Idempotency, failure, and recovery
Health and smoke checks are repeatable. Gateway retry/fallback policy must use stable logical-call identity and prevent double charging.

## Extension rules and forbidden dependencies
Keep deployment adapter configuration here; Model Gateway owns invocation and business integration, and no business policy belongs in LiteLLM YAML.

## Current gotchas
The Platform Model Gateway consumes this adapter for bounded non-streaming text chat only. Streaming, tools, reasoning and generation modalities remain uncertified.

## Verification
Run the health/smoke scripts only against an explicitly provisioned test endpoint, plus Root model-gateway compatibility tests.
