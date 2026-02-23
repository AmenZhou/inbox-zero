#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${SCRIPT_DIR}/../apps/web"
ENV_FILE="${WEB_DIR}/.env"

# Check for --remote flag to use the API endpoint instead of the standalone script
if [[ "${1:-}" == "--remote" ]]; then
  shift

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
    echo "Catching up history for: $1 (remote)"
    curl -s -H "Authorization: Bearer $CRON_SECRET" "${ENDPOINT}?email=$1" | jq .
  else
    echo "Catching up history for all accounts (remote)"
    curl -s -H "Authorization: Bearer $CRON_SECRET" "$ENDPOINT" | jq .
  fi
else
  # Default: run the standalone TypeScript script directly (no server needed)
  if [ -n "${1:-}" ]; then
    echo "Catching up history for: $1"
    cd "$WEB_DIR" && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/catchUpHistory.ts "$1"
  else
    echo "Catching up history for all accounts"
    cd "$WEB_DIR" && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/catchUpHistory.ts
  fi
fi
