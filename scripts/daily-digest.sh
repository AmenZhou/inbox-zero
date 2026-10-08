#!/bin/bash
# Sends the daily digest for one account and nothing else: it only ever runs apps/web/scripts/dailySummary.ts,
# so no Gmail history catch-up (labels, archive, drafts) can run from here, even if other code is reverted.
# launchd calls this instead of catch-up-history.sh; if this file is missing the job fails instead of falling back to a catch-up.
# Usage: daily-digest.sh <email> [--hours=<n>]   (--hours is a manual window: it does not move the watermark)
# Env: DIGEST_RETRY_SLEEP = seconds between attempts (default 90; tests set 0).

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

# A failed attempt that sent nothing is retried (the first scheduled run failed on a network that was not up yet after wake).
# A failure AFTER "Digest email sent" is never retried: that would send the digest twice.
# Not exec'd on purpose: it has to loop. Everything is still logged (tee), the last attempt's exit code is returned.
out=$(mktemp)
trap 'rm -f "$out"' EXIT
rc=0
for attempt in 1 2 3; do
  rc=0
  NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/dailySummary.ts "$@" 2>&1 | tee "$out" || rc=$?
  [[ $rc -eq 0 ]] && break
  grep -q "Digest email sent" "$out" && break
  if [[ $attempt -lt 3 ]]; then
    echo "Attempt $attempt failed (exit $rc) before any digest was sent; retrying in ${DIGEST_RETRY_SLEEP:-90}s"
    sleep "${DIGEST_RETRY_SLEEP:-90}"
  fi
done
exit "$rc"
