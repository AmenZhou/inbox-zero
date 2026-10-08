# Changelog

## 2026-10-07

### Changed

- **Digest cap now applies after grouping (deliberate behaviour change)** (`scripts/dailySummary.ts`)
  - Before, the 200-item cap cut the received-order list first, so an Urgent email at position 201 or later was hidden. Now the digest is grouped and ordered by tag priority first, then cut at 200: the highest-priority groups are kept whole, and what is hidden is the tail of the lowest-priority groups (ultimately Untagged), in received order within each group
  - The "+N more" notice and its "Among them: ..." tag counts now describe the emails that are actually hidden (usually untagged or low-priority ones), so they are often shorter than before
  - This supersedes the 2026-10-06 note that the cap applies to the received-order list before grouping
- **Digest query excludes only the account's own digest** (`scripts/dailySummary.ts`)
  - The exclusion `-subject:"Daily Inbox Digest"` is now `-(from:me subject:"Daily Inbox Digest")`, so a foreign or forwarded mail with that subject is still digested. Checked read-only against Gmail (message counts only): the grouped negation is honoured, the account's own digest is still excluded and the rest of the window is unchanged

### Fixed

- **A failed digest run no longer looks successful** (`scripts/dailySummary.ts`, `scripts/catchUpHistory.ts`)
  - `sendDailySummary` now returns `'sent' | 'skipped' | 'error'`. "Email account not found" and "Missing Gmail tokens" (`'error'`) make `dailySummary.ts` (and so `scripts/daily-digest.sh`) and `catchUpHistory.ts --summary-only` exit non-zero. `--send-summary` is unchanged: it logs the error and continues with the catch-up
- **One bad email can no longer lose the whole digest** (`scripts/dailySummary.ts`)
  - `getDigestTagCandidates` and `getEmailForLLM` now run inside the per-email task: a throw gives that email a "Summary unavailable" item (with its static tags if they could be computed) instead of rejecting the whole batch
- **The scheduled digest retries on a transient failure** (`scripts/daily-digest.sh`)
  - The first scheduled run (2026-10-07 17:00) failed with `fetch failed` / `ConnectTimeoutError` before sending anything, most likely because the network was not up yet after wake. The script now makes up to 3 attempts with `DIGEST_RETRY_SLEEP` seconds between them (default 90), retrying only when an attempt failed and its output has no "Digest email sent" line (a retry after a send would duplicate the digest). The last attempt's exit code is returned and all output still goes to the log. Argument checking is unchanged and the catch-up code is still never reached
  - The script no longer `exec`s npx (it has to loop); it stays executable
  - New tests: `scripts/dailyDigestSh.test.ts` (stub `npx`), plus cases in `dailySummary.test.ts` and `catchUpHistory.test.ts`

## 2026-10-06

### Added

- **Digest-only mode and a dedicated digest script**
  - `scripts/daily-digest.sh <email> [--hours=<n>]` runs only `apps/web/scripts/dailySummary.ts`, so it can never run the Gmail history catch-up (labels, archive, drafts); it exits 1 with a usage line unless given exactly an email and optionally `--hours=<n>`. Point the launchd job at this script: if the file is missing (code reverted or another branch checked out) the job fails visibly instead of falling back to a catch-up
  - `catchUpHistory.ts` and `scripts/catch-up-history.sh` accept `--summary-only`: send the digest for the given email and exit before any catch-up work (no rule runs, `lastSyncedHistoryId` untouched). It needs an email and cannot be combined with `--remote`
  - Both the wrapper and `catchUpHistory.ts` now reject unknown `--` flags (exit 1), so a mistyped flag can no longer silently run the full catch-up
- **Rule tags on each digest item** (`utils/ai/digest/digest-tags.ts`, `summarize-email-for-digest.ts`, `scripts/dailySummary.ts`)
  - Each digest item shows chips for the Gmail labels of the account's enabled labelling rules that apply to it. Rules without instructions (e.g. Tianguo Band) are matched in code with the rules engine's matcher; rules with instructions are passed to the same single summary call as `tagCandidates`, and the returned names are validated against the real labels. Conversation trackers and the Cold Email blocker are skipped
  - No extra LLM call per email (about +1,090 input tokens, roughly +$0.00015 per email); items keep their received order; the "+N more" notice also lists the tags of the omitted items
- **Digest grouped by tag** (`scripts/dailySummary.ts`)
  - The emails in the Daily Inbox Digest are now grouped under a header per tag (`Urgent (3)`), in a fixed order: Urgent, Tianguo Band, Recruiters, need an action, To Reply, Dev, FYI, Social, Newsletter, Receipt, Marketing, then any other tag A-Z, then Untagged. An email with several tags appears once, under its highest-priority tag; its other tags stay as chips. Inside a group the received order is kept; empty groups are not shown; with no tags at all the digest is a plain list as before
  - The 200-item cap still applies to the received-order list before grouping, so the same emails are hidden and the "+N more" notice still names the hidden tags; fallback ("Summary unavailable") entries are grouped by their static tags, else under Untagged
  - A new labelling rule appears as its own group after the listed ones until its label is added to `TAG_PRIORITY`
  - No new LLM call, token or dollar impact (rendering only); no schema, env or dependency change. The 200-item digest is about 26 KB smaller than with a chip per tag

### Changed

- **Digest watermark and window** (`scripts/dailySummary.ts`)
  - `lastDigestSentAt` is now the time the window was read, not the time the send finished, so mail arriving while summaries run lands in the next digest; the query excludes the previous `Daily Inbox Digest` email
  - A summary the model answers with the literal `null` (spam/promotional) is shown as "(Promotional or not relevant, no summary.)"
  - `SUMMARY_CONCURRENCY` goes from 4 to 3 because the tag list roughly doubles the tokens per call (200K tokens/min account limit)
  - No new env var and no dependency change

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
