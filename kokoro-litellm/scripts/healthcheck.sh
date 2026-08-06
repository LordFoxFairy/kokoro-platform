#!/usr/bin/env sh
set -eu

HOST="${LITELLM_HOST:-localhost}"
PORT="${LITELLM_PORT:-4000}"
SCHEME="${LITELLM_SCHEME:-https}"
PATHNAME="${LITELLM_HEALTH_PATH:-/health/liveliness}"
URL="${LITELLM_HEALTH_URL:-${SCHEME}://${HOST}:${PORT}${PATHNAME}}"
CA_CERT_FILE="${LITELLM_CA_CERT_FILE:-./secrets/ca.crt}"

if [ -n "${CA_CERT_FILE}" ]; then
  curl --cacert "${CA_CERT_FILE}" -fsS "${URL}" >/dev/null
else
  curl -fsS "${URL}" >/dev/null
fi
