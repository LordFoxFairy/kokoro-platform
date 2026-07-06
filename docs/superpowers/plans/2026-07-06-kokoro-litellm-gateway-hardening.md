# kokoro-litellm Gateway Hardening Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden `kokoro-litellm` as an external LiteLLM gateway configuration package with clear runtime contract, safer environment defaults, health checks, and smoke checks.

**Architecture:** Do not add DB schema, Prisma, admin manifest, or business lifecycle methods. Keep LiteLLM as a mature external gateway and document the only business contract: `kokoro-model.gatewayModelName` maps to LiteLLM `model_name`.

**Tech Stack:** LiteLLM official Docker image, Docker Compose example, POSIX shell, YAML config, Markdown runbook.

---

## Preconditions

- Worktree: `/Users/nako/WebstormProjects/github/thefoxfairy/Kokoro/.gitwarp/worktrees/agent/polish-kokoro-platform/kokoro-platform`
- Focus only `kokoro-litellm` plus litellm docs.
- No DB lifecycle: this directory owns no business rows.
- Do not add a package manager or custom gateway implementation.
- Do not commit real provider keys.

## File Map

- Modify: `kokoro-litellm/.env.example`
  Add host/base URL/health URL knobs and comments for production image pinning.
- Modify: `kokoro-litellm/README.md`
  Split quick start, boundary, contract, verification, and production notes.
- Create: `kokoro-litellm/CONTRACT.md`
  Cross-module contract with `kokoro-model`, runtime call sequence, and anti-ownership rules.
- Modify: `kokoro-litellm/config/litellm.config.example.yaml`
  Add comments and keep `model_name` examples aligned with `gatewayModelName`.
- Modify: `kokoro-litellm/docker-compose.example.yml`
  Use the env knobs consistently and keep config read-only.
- Modify: `kokoro-litellm/scripts/healthcheck.sh`
  Support `LITELLM_HEALTH_URL` and `LITELLM_SCHEME`.
- Create: `kokoro-litellm/scripts/smoke-openai-compatible.sh`
  Verify `/v1/models` with `LITELLM_MASTER_KEY`.

## Chunk 1: Docs And Contract

### Task 1: Runtime Contract

**Files:**
- Create: `kokoro-litellm/CONTRACT.md`
- Modify: `kokoro-litellm/README.md`

- [ ] Write contract that states:
  - `kokoro-model` owns model catalog, provider account status, binding lifecycle, label visibility.
  - `kokoro-litellm` owns only gateway runtime config.
  - `ModelBinding.gatewayModelName` must match LiteLLM `model_name`.
  - Credit quote/hold/capture stays in `kokoro-credit`.
- [ ] Update README quick start and production notes.
- [ ] Run:

```bash
git diff --check
```

Expected: docs have no trailing whitespace.

## Chunk 2: Config And Env Template

### Task 2: Environment Template

**Files:**
- Modify: `kokoro-litellm/.env.example`

- [ ] Add:
  - `LITELLM_HOST`
  - `LITELLM_SCHEME`
  - `LITELLM_BASE_URL`
  - `LITELLM_HEALTH_PATH`
  - `LITELLM_HEALTH_URL`
- [ ] Keep `LITELLM_MASTER_KEY` as placeholder only.
- [ ] Add comment that production should pin `LITELLM_IMAGE`.
- [ ] Run:

```bash
rg -n "sk-[A-Za-z0-9]{20,}" kokoro-litellm
```

Expected: no real-looking secret in committed examples.

### Task 3: Config Example

**Files:**
- Modify: `kokoro-litellm/config/litellm.config.example.yaml`

- [ ] Add comments explaining `model_name` must match `gatewayModelName`.
- [ ] Keep provider keys as `os.environ/...`.
- [ ] Do not add pricing or user/team/site policy.
- [ ] Run:

```bash
git diff --check kokoro-litellm/config/litellm.config.example.yaml
```

Expected: no whitespace errors.

## Chunk 3: Scripts And Compose

### Task 4: Healthcheck Script

**Files:**
- Modify: `kokoro-litellm/scripts/healthcheck.sh`

- [ ] Add `SCHEME="${LITELLM_SCHEME:-http}"`.
- [ ] Add `URL="${LITELLM_HEALTH_URL:-${SCHEME}://${HOST}:${PORT}${PATHNAME}}"`.
- [ ] Curl `URL`.
- [ ] Run:

```bash
sh -n kokoro-litellm/scripts/healthcheck.sh
```

Expected: shell syntax passes.

### Task 5: OpenAI-Compatible Smoke Script

**Files:**
- Create: `kokoro-litellm/scripts/smoke-openai-compatible.sh`

- [ ] Require `LITELLM_MASTER_KEY`.
- [ ] Use `LITELLM_BASE_URL` or `LITELLM_SCHEME/HOST/PORT`.
- [ ] Call `/models` under the OpenAI-compatible base path.
- [ ] Run:

```bash
sh -n kokoro-litellm/scripts/smoke-openai-compatible.sh
```

Expected: shell syntax passes.

### Task 6: Docker Compose Example

**Files:**
- Modify: `kokoro-litellm/docker-compose.example.yml`

- [ ] Keep official image env override.
- [ ] Keep config mounted read-only.
- [ ] Use healthcheck script-equivalent env values or inline curl with env defaults.
- [ ] Run:

```bash
docker compose -f kokoro-litellm/docker-compose.example.yml config
```

Expected: compose config renders without errors.

## Chunk 4: Verification And Commit

### Task 7: Verification

**Files:** no edits unless failures require fixes.

- [ ] Run:

```bash
sh -n kokoro-litellm/scripts/healthcheck.sh
sh -n kokoro-litellm/scripts/smoke-openai-compatible.sh
docker compose -f kokoro-litellm/docker-compose.example.yml config
git diff --check
```

- [ ] Check no special business delete naming was introduced; this subrepo has no business delete/restore API.
- [ ] Check no forbidden external reference string was introduced.

Expected: all checks pass.

### Task 8: Scoped Commit

**Files:**
- Stage only `kokoro-litellm` and litellm tech/plan docs.

- [ ] Inspect status:

```bash
git status --short
```

- [ ] Stage exact scope:

```bash
git add kokoro-litellm docs/platform/tech/2026-07-06-kokoro-litellm-gateway-hardening.md docs/superpowers/plans/2026-07-06-kokoro-litellm-gateway-hardening.md
```

- [ ] Inspect staged files:

```bash
git diff --cached --name-only
```

- [ ] Commit:

```bash
git commit -m "docs(litellm): add gateway hardening plan"
```

Expected: commit contains litellm plan/docs only.
