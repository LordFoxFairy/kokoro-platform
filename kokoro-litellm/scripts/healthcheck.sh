#!/usr/bin/env sh
set -eu

HOST="${LITELLM_HOST:-127.0.0.1}"
PORT="${LITELLM_PORT:-4000}"
SCHEME="${LITELLM_SCHEME:-http}"
PATHNAME="${LITELLM_HEALTH_PATH:-/health/liveliness}"
URL="${LITELLM_HEALTH_URL:-${SCHEME}://${HOST}:${PORT}${PATHNAME}}"

curl -fsS "${URL}" >/dev/null
