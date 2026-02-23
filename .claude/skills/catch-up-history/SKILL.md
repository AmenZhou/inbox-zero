---
name: catch-up-history
description: Run the Gmail history catch-up script to recover missed webhook notifications
user_invocable: true
---
# Gmail History Catch-Up

Runs the catch-up script to process missed Gmail webhook notifications.

## How to Run

```bash
# All accounts (standalone, no server needed)
./scripts/catch-up-history.sh

# Single account (standalone)
./scripts/catch-up-history.sh chou.amen@gmail.com

# Via API endpoint (requires running server)
./scripts/catch-up-history.sh --remote
./scripts/catch-up-history.sh --remote chou.amen@gmail.com

# Directly with tsx
cd apps/web && npx tsx scripts/catchUpHistory.ts [email]
```

The standalone script loads env vars from `apps/web/.env` and connects directly to the database and Gmail API. The `--remote` flag calls the API endpoint instead (requires `CRON_SECRET`).

## What It Does

- Connects directly to the database and Gmail API (no server needed)
- Paginates through all missed Gmail history items (no 500-item cap)
- Runs automation rules (labeling, archiving, drafting replies, etc.) on missed emails
- Updates `lastSyncedHistoryId` in the database after each batch
- Handles expired history IDs (>1 week old) by resetting the sync pointer
- Outputs results as JSON to stdout

## Key Files

- **Shell wrapper:** `scripts/catch-up-history.sh`
- **Standalone script:** `apps/web/scripts/catchUpHistory.ts`
- **API Route:** `apps/web/app/api/cron/catch-up-history/route.ts`
- **Docs:** `docs/catch-up-history.md`

## When to Use

- After server downtime or webhook interruptions
- When emails appear in Gmail without labels that automation rules should have applied
- As a periodic cron job to ensure no webhooks are missed
