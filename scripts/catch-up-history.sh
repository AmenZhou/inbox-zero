#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="${SCRIPT_DIR}/../apps/web"
ENV_FILE="${WEB_DIR}/.env"

# Detect --send-summary / --summary-only anywhere in args and separate them out
SEND_SUMMARY=""
SUMMARY_ONLY=""
NEW_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--send-summary" ]]; then
    SEND_SUMMARY="--send-summary"
  elif [[ "$arg" == "--summary-only" ]]; then
    SUMMARY_ONLY="--summary-only"
  elif [[ "$arg" == --* && "$arg" != "--remote" ]]; then
    echo "Error: unknown flag $arg (known: --send-summary, --summary-only, --remote)" >&2
    exit 1
  else
    NEW_ARGS+=("$arg")
  fi
done

# --summary-only is the digest for one account: the remote endpoint always runs the catch-up, so it can never honour it.
if [[ -n "$SUMMARY_ONLY" && ( -z "${NEW_ARGS[0]:-}" || "${NEW_ARGS[0]}" == "--remote" ) ]]; then
  echo "Error: --summary-only needs an email and cannot be combined with --remote" >&2
  exit 1
fi

# Check for --remote flag to use the API endpoint instead of the standalone script
if [[ "${NEW_ARGS[0]:-}" == "--remote" ]]; then
  unset "NEW_ARGS[0]"
  NEW_ARGS=("${NEW_ARGS[@]:-}")

  if [ -f "$ENV_FILE" ]; then
    export $(grep "^CRON_SECRET=" "$ENV_FILE" | xargs)
  fi

  BASE_URL="${BASE_URL:-https://webhook.zhouhaimeng.com}"
  ENDPOINT="${BASE_URL}/api/cron/catch-up-history"

  if [ -z "${CRON_SECRET:-}" ]; then
    echo "Error: CRON_SECRET not found in $ENV_FILE or environment" >&2
    exit 1
  fi

  if [ -n "${NEW_ARGS[0]:-}" ]; then
    echo "Catching up history for: ${NEW_ARGS[0]} (remote)"
    curl -s -H "Authorization: Bearer $CRON_SECRET" "${ENDPOINT}?email=${NEW_ARGS[0]}" | jq .
  else
    echo "Catching up history for all accounts (remote)"
    curl -s -H "Authorization: Bearer $CRON_SECRET" "$ENDPOINT" | jq .
  fi
else
  # Default: run the standalone TypeScript script directly (no server needed)
  if [ -n "${NEW_ARGS[0]:-}" ]; then
    if [[ -n "$SUMMARY_ONLY" ]]; then
      echo "Sending daily summary only for: ${NEW_ARGS[0]}"
    else
      echo "Catching up history for: ${NEW_ARGS[0]}${SEND_SUMMARY:+ (with daily summary)}"
    fi
    cd "$WEB_DIR" && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs \
      scripts/catchUpHistory.ts "${NEW_ARGS[0]}" $SEND_SUMMARY $SUMMARY_ONLY
  else
    echo "Catching up history for all accounts"
    cd "$WEB_DIR" && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs \
      scripts/catchUpHistory.ts $SEND_SUMMARY $SUMMARY_ONLY
  fi
fi
