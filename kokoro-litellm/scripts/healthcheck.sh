#!/usr/bin/env sh
set -eu

HOST="${LITELLM_HOST:-127.0.0.1}"
PORT="${LITELLM_PORT:-4000}"
PATHNAME="${LITELLM_HEALTH_PATH:-/health/liveliness}"

curl -fsS "http://${HOST}:${PORT}${PATHNAME}" >/dev/null
