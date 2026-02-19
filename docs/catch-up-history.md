# Gmail History Catch-Up Endpoint

## Problem

When the local server is stopped or Gmail push notification webhooks are paused, incoming notifications are missed. The existing webhook handler caps processing at 500 history items and does not paginate, so a large gap after downtime can result in skipped emails.

Gmail history IDs are valid for approximately one week, so catch-up is only possible within that window.

## Endpoint

```
GET /api/cron/catch-up-history
```

### Authentication

Requires `CRON_SECRET` via the `Authorization` header:

```
Authorization: Bearer <CRON_SECRET>
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `email`   | No       | Limit catch-up to a single email account (e.g. `user@example.com`) |

### Behavior

1. Queries all Google email accounts that have valid tokens and a `lastSyncedHistoryId` set in the database.
2. For each account:
   - Validates the account (premium status, active rules, connected tokens).
   - Fetches the current `historyId` from Gmail via `users.getProfile()`.
   - Paginates through all history from `lastSyncedHistoryId` to the current `historyId` in batches of 500.
   - Processes each batch using the same `processHistory` logic as the webhook handler.
   - Updates `lastSyncedHistoryId` after each batch (monotonic — never regresses).
3. If a history ID has expired (Gmail returns 404), the sync pointer is reset to the current `historyId`.

### Response

```json
{
  "accounts": [
    {
      "email": "user@example.com",
      "status": "ok",
      "pagesProcessed": 3,
      "itemsProcessed": 1247
    },
    {
      "email": "other@example.com",
      "status": "skipped"
    },
    {
      "email": "expired@example.com",
      "status": "expired_reset",
      "pagesProcessed": 0,
      "itemsProcessed": 0
    }
  ]
}
```

#### Status values

| Status          | Meaning |
|-----------------|---------|
| `ok`            | History was successfully caught up |
| `skipped`       | Account was skipped (validation failed, missing tokens, etc.) |
| `expired_reset` | History ID had expired; sync pointer was reset to current |
| `error`         | An unexpected error occurred (details in the `error` field) |

## Usage

### Catch up all accounts

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/catch-up-history
```

### Catch up a single account

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/cron/catch-up-history?email=user@example.com"
```

### Run on a schedule

You can configure this endpoint as a periodic cron job (e.g. every 15 minutes) to ensure missed webhooks are automatically recovered:

```
*/15 * * * * curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/catch-up-history
```

## Implementation Details

- **Route file:** `apps/web/app/api/cron/catch-up-history/route.ts`
- **Max duration:** 300 seconds (5 minutes)
- Reuses `processHistory` and `updateLastSyncedHistoryId` from `apps/web/app/api/google/webhook/process-history.ts`
- Reuses `getHistory` from `apps/web/utils/gmail/history.ts` (with `pageToken` support for pagination)
- Account validation uses the same `validateWebhookAccount` pipeline as the webhook handler
