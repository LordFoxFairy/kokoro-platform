#!/usr/bin/env sh
set -eu

HOST="${LITELLM_HOST:-127.0.0.1}"
PORT="${LITELLM_PORT:-4000}"
SCHEME="${LITELLM_SCHEME:-http}"
BASE_URL="${LITELLM_BASE_URL:-${SCHEME}://${HOST}:${PORT}/v1}"

if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "LITELLM_MASTER_KEY is required" >&2
  exit 2
fi

curl -fsS \
  -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
  "${BASE_URL%/}/models" >/dev/null
