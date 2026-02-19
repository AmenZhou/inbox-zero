# Changelog

## 2026-02-18

### Added

- **Gmail History Catch-Up Endpoint** (`/api/cron/catch-up-history`)
  - New cron endpoint that recovers missed Gmail webhook notifications after server downtime
  - Paginates through all missed history (no 500-item cap like the webhook handler)
  - Supports optional `?email=` param to target a single account
  - Handles expired history IDs (>1 week old) gracefully by resetting the sync pointer
  - See [catch-up-history.md](./catch-up-history.md) for full documentation

- **Catch-up shell script** (`scripts/catch-up-history.sh`)
  - Convenience script that auto-loads `CRON_SECRET` from `apps/web/.env`
  - Defaults to production URL; accepts optional email argument
  - Usage: `./scripts/catch-up-history.sh [email]`

### Changed

- **History pagination support** (`utils/gmail/history.ts`)
  - Added `pageToken` parameter to `getHistory` to support paginated fetches

- **Exported internal webhook functions** (`app/api/google/webhook/process-history.ts`)
  - Exported `processHistory` and `updateLastSyncedHistoryId` for reuse by the catch-up endpoint

### Fixed

- **AI chat search failing on subjects with quotes** (`utils/ai/assistant/chat-inbox-tools.ts`)
  - Updated `searchInbox` tool description to guide the LLM away from nested quoted queries (e.g. `subject:"You signed: \"...\""`) which Gmail cannot parse
  - Model now uses simple keyword queries that return correct results
