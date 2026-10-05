# Changelog

## 2026-10-05

### Added

- **GPT-6 Luna reasoning support** (`utils/llms/model.ts`)
  - `selectDefaultModel` now sets `providerOptions.openai.forceReasoning` when the env-default OpenAI model id starts with `gpt-6`; the installed `@ai-sdk/openai` 3.0.26 only treats `o*` / `gpt-5*` ids as reasoning models and silently drops `reasoningEffort` for `gpt-6-*`
  - There is no global reasoning-effort default: callers that do not opt in run at the model's own default effort
  - New `withHighReasoningEffort(modelOptions)` helper deep-merges `reasoningEffort: "high"` into the model's `openai` options (OpenAI only; other providers are returned unchanged and the input is never mutated). The deep merge is needed because the LLM wrappers merge per-call `providerOptions` shallowly per provider key, so a bare override would drop `forceReasoning` and `store: false`
  - Co-located tests for model selection, the helper, wrapper merge behaviour and the per-caller opt-ins

- **Live account configuration (database rules and settings, not repo changes)**
  - **Urgent**: an enabled, label-only AI rule that applies the label "Urgent"
  - **Tianguo Band**: three enabled, label-only static rules that apply the label "Tianguo Band" (recipient `ny-tianguo-band-*@googlegroups.com|@tianguo.band`, sender `@tianguo.band`, subject `天国乐团|Tianguo|TianGuo`)
  - **Recruiters**: an enabled, label-only AI rule that applies the label "Recruiters"; mail stays in the inbox. The Cold Email blocker is unchanged and still runs first, so a first-time sender classified as cold email is handled by the Cold Email rule alone
  - Multi-rule selection enabled (`EmailAccount.multiRuleSelectionEnabled` = true) so Urgent can stack with other AI rules; this is an account-wide behaviour change. No pre-existing rule was modified
  - Created with `scripts/importRules.ts`; the exported rule YAML snapshots are gitignored (`apps/web/inbox-zero-rules*.yaml`)

### Changed

- **Default LLM is now OpenAI `gpt-6-luna`** (configuration, not a repo change)
  - Set through `DEFAULT_LLM_MODEL` in `apps/web/.env` (untracked); `DEFAULT_LLM_PROVIDER` stays `openai`
  - The economy and chat model types fall back to the default when their own env pair is unset, so they also resolve to `gpt-6-luna` at default effort
  - No new env var and no dependency change

- **High reasoning effort for AI rule choice and draft replies** (`utils/ai/choose-rule/ai-choose-rule.ts`, `utils/ai/reply/draft-reply.ts`)
  - Both callers wrap `getModel(...)` in `withHighReasoningEffort`; every other call keeps the model's default effort

- **Daily digest summaries run with bounded concurrency** (`scripts/dailySummary.ts`)
  - Per-email summaries go through a `p-queue` with `SUMMARY_CONCURRENCY = 4` instead of an unbounded `Promise.all` over up to `MAX_DIGEST_MESSAGES` (1000) emails, to stay inside the account's OpenAI rate limits
  - Result order, the retry/fallback handling and the summarized + fallback = unprocessed reconciliation are unchanged
  - New `scripts/dailySummary.test.ts` covers the concurrency cap, ordering, fallback and retry

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
