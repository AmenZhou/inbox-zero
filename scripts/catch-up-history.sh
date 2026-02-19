#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../apps/web/.env"

if [ -f "$ENV_FILE" ]; then
  export $(grep "^CRON_SECRET=" "$ENV_FILE" | xargs)
fi

BASE_URL="${BASE_URL:-https://webhook.zhouhaimeng.com}"
ENDPOINT="${BASE_URL}/api/cron/catch-up-history"

if [ -z "${CRON_SECRET:-}" ]; then
  echo "Error: CRON_SECRET not found in $ENV_FILE or environment" >&2
  exit 1
fi

if [ -n "${1:-}" ]; then
  echo "Catching up history for: $1"
  curl -s -H "Authorization: Bearer $CRON_SECRET" "${ENDPOINT}?email=$1" | jq .
else
  echo "Catching up history for all accounts"
  curl -s -H "Authorization: Bearer $CRON_SECRET" "$ENDPOINT" | jq .
fi
