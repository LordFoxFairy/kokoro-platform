#!/usr/bin/env sh
set -eu

HOST="${LITELLM_HOST:-localhost}"
PORT="${LITELLM_PORT:-4000}"
SCHEME="${LITELLM_SCHEME:-https}"
BASE_URL="${LITELLM_BASE_URL:-${SCHEME}://${HOST}:${PORT}/v1}"
CA_CERT_FILE="${LITELLM_CA_CERT_FILE:-./secrets/ca.crt}"

if [ -z "${LITELLM_MASTER_KEY:-}" ]; then
  echo "LITELLM_MASTER_KEY is required" >&2
  exit 2
fi

if [ -n "${CA_CERT_FILE}" ]; then
  curl --cacert "${CA_CERT_FILE}" -fsS \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
    "${BASE_URL%/}/models" >/dev/null
else
  curl -fsS \
    -H "Authorization: Bearer ${LITELLM_MASTER_KEY}" \
    "${BASE_URL%/}/models" >/dev/null
fi
