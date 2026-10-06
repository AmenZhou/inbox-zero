#!/bin/bash
# Sends the daily digest for one account and nothing else: it only ever runs apps/web/scripts/dailySummary.ts,
# so no Gmail history catch-up (labels, archive, drafts) can run from here, even if other code is reverted.
# launchd calls this instead of catch-up-history.sh; if this file is missing the job fails instead of falling back to a catch-up.
# Usage: daily-digest.sh <email> [--hours=<n>]   (--hours is a manual window: it does not move the watermark)

set -euo pipefail

usage() {
  echo "Usage: daily-digest.sh <email> [--hours=<n>]" >&2
  exit 1
}

# dailySummary.ts ignores unknown flags and reads "--hours 48" (with a space) as 24, so accept only the exact forms it honours.
[[ $# -ge 1 && $# -le 2 && "$1" == *@* && "$1" != -* ]] || usage
if [[ $# -eq 2 ]]; then
  [[ "$2" =~ ^--hours=[1-9][0-9]*$ ]] || usage
fi

cd "$(dirname "${BASH_SOURCE[0]}")/../apps/web"
echo "Sending daily digest only for: $1"
NODE_ENV=production exec npx tsx -r ./scripts/stub-server-only.cjs scripts/dailySummary.ts "$@"
