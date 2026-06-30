# Decision: Catch-up summary window strategy (R-1)

**Status:** Decided. Read-only research ticket. Implemented by CU-1.
**Date:** 2026-06-29

## Problem

`apps/web/scripts/dailySummary.ts` → `sendDailySummary()` hard-codes a 24-hour Gmail
query window:

```ts
// dailySummary.ts:16  export async function sendDailySummary(email: string, hours = 24)
// dailySummary.ts:69
const query = `in:inbox newer_than:${hours}h -label:Marketing -label:Newsletter -label:Receipt -category:promotions`;
```

The catch-up launchd job (`scripts/com.inbox-zero.catchup.plist`) fires once daily at
**17:00 with `WakeFromSleep`** (`StartCalendarInterval` Hour=17 Minute=0). If the Mac was
asleep across one or more whole days, the job runs once on wake and the backlog can span
multiple days. With a fixed `newer_than:24h` window, every email **older than 24h but newer
than the last successful digest is never summarized** — it falls into a permanent gap.

## Decision

**Strategy (A): persist a per-account "last digest sent" timestamp and query Gmail with
`after:<unix-seconds>` ("everything since the last digest"), with a 72h fallback when null.**

This is the recommended default and the investigation confirmed it is the right one (B and C
are rejected below). CU-1 implements it.

### Concrete window expression CU-1 will use

Replace the `newer_than:Nh` clause with an `after:<epoch-seconds>` clause computed from the
persisted timestamp, falling back to a 72h-ago epoch on first run / null:

```ts
const FALLBACK_HOURS = 72;
const now = Date.now();

// lastDigestSentAt is the new EmailAccount field (see schema section)
const sinceMs = emailAccount.lastDigestSentAt
  ? emailAccount.lastDigestSentAt.getTime()
  : now - FALLBACK_HOURS * 60 * 60 * 1000;

// Gmail `after:` takes Unix seconds (it also accepts YYYY/MM/DD; epoch seconds is exact).
const afterEpoch = Math.floor(sinceMs / 1000);

const query = `in:inbox after:${afterEpoch} -label:Marketing -label:Newsletter -label:Receipt -category:promotions`;
```

Worked example: if the last digest was sent at `2024-06-30T00:00:00Z`, the query becomes
literally `in:inbox after:1719705600 -label:Marketing ...`.

After a digest is **successfully sent** (i.e. immediately after the existing
`gmail.users.messages.send(...)` call at `dailySummary.ts:152`), CU-1 stamps the field:

```ts
await prisma.emailAccount.update({
  where: { id: emailAccount.id },
  data: { lastDigestSentAt: new Date() },
});
```

`--hours` stays supported as a manual override: when a `--hours` arg is explicitly passed,
keep using `newer_than:${hours}h` and do NOT advance `lastDigestSentAt` (manual/ad-hoc runs
must not move the watermark). The automatic catch-up path passes no `--hours` and uses the
`after:` watermark.

## Gmail client support for `after:<epoch>`

Confirmed. `after:` is a standard Gmail search operator and accepts Unix-epoch **seconds**.
The query string is passed verbatim through the existing helpers with no special handling:

- `dailySummary.ts:73` calls `queryBatchMessagesPages(gmail, { query, maxResults: 100 })`.
- `utils/gmail/message.ts:317` `queryBatchMessagesPages` → `:331` `queryBatchMessages` →
  `:307` `getMessages` → `:261` `gmail.users.messages.list({ q: options.query, ... })`.
  The query string is forwarded untouched to `messages.list`'s `q` param.
- Precedent in the same file: `utils/gmail/message.ts:202-203` already builds a
  `... before:${beforeTimestamp}` query from `Math.floor(dateInSeconds)`, proving epoch-second
  date operators work through these helpers.

So no client change is needed — only the query string built in `dailySummary.ts` changes.

## Schema finding: is there an existing usable timestamp?

Schema file: `apps/web/prisma/schema.prisma` (single file; no shared `packages/` schema).

There are three candidate fields, but **none is a clean fit to reuse**, so a new field is
required:

| Candidate | Location | Owner / why NOT reusable |
|---|---|---|
| `EmailAccount.lastSummaryEmailAt DateTime?` | `schema.prisma:135` (indexed `:192`) | Owned by the **weekly stats summary** feature, not the daily digest. Read+written by `apps/web/app/api/resend/summary/route.ts:92,100,290`. Reusing it would entangle two unrelated cadences (weekly stats vs. daily catch-up) and break that feature's "don't resend within 3 days" guard. Reject. |
| `Digest.sentAt DateTime?` | `schema.prisma:275` | Owned by the in-app digest pipeline. Written by `apps/web/app/api/resend/digest/route.ts:355` when `Digest` rows are marked `SENT`. The standalone `dailySummary.ts` script does **not** create `Digest`/`DigestItem` rows at all — it sends a raw Gmail message directly (`dailySummary.ts:152`). Deriving "last sent" by `MAX(Digest.sentAt)` would read a table this script never writes, giving wrong/empty watermarks. Reject. |
| `DigestItem` (`messageId`,`threadId`, `@@unique([digestId,threadId,messageId])`) | `schema.prisma:281-295` | Same table-not-written-by-this-script problem. Not a timestamp anyway. |

**Conclusion: the schema does NOT have a usable "last daily-digest sent" field for this
script.** CU-1 must add one.

### Exact migration CU-1 must add

Add to `model EmailAccount` in `apps/web/prisma/schema.prisma` (alongside the existing
`lastSummaryEmailAt` at line 135, to keep digest/summary watermarks together):

```prisma
lastDigestSentAt DateTime?
```

- **Field name:** `lastDigestSentAt`
- **Type:** `DateTime?` (nullable — null means "never sent / first run")
- **Default:** none (nullable, no `@default`). Null is the explicit first-run signal that
  triggers the fallback window. Do NOT default it to `now()` — that would silently swallow
  the entire pre-existing backlog on the first run after deploy.
- No index needed (looked up only by the `EmailAccount` primary-key query already in the
  script at `dailySummary.ts:19`).

Then generate the migration:

```bash
cd apps/web && pnpm prisma migrate dev --name add_last_digest_sent_at
```

(R-1 is read-only and does NOT run this — CU-1 runs it.)

## Duplicate suppression (same email not summarized twice)

Two independent layers guarantee no email is summarized across two consecutive runs:

1. **Watermark advance (primary).** The window's lower bound is the timestamp of the previous
   successful send. The next run uses `after:<lastDigestSentAt>`, so already-summarized
   messages are below the window and never re-fetched. Because the stamp is written **only
   after** a successful `messages.send`, a crashed/failed run leaves the watermark unmoved and
   those emails are correctly retried next time (at-least-once, no permanent gap).

2. **Existing `executedRule` filter (secondary, unchanged).** `dailySummary.ts:85-94` already
   drops any message that the rules engine has already processed
   (`prisma.executedRule.findMany(... messageId in ...)`). This stays as-is and covers the
   one boundary edge: a message whose `internalDate` equals the watermark second. Gmail's
   `after:` is inclusive of the boundary second, so a same-second message *could* reappear;
   this filter (plus the fact such a message was just summarized and would typically be
   rule-processed) absorbs it. The overlap is at most one second and bounded to messages with
   the identical internal timestamp — acceptable and self-healing.

No new dedup table or `DigestItem` write is introduced.

## First-run / null-timestamp fallback

**Fallback window: 72 hours.** When `lastDigestSentAt` is null (fresh account, or first run
after this feature ships), query `after:<now - 72h>`.

Rationale:
- 72h comfortably covers a normal weekend-plus-a-day sleep gap, so the very first catch-up
  after deploy still surfaces a meaningful backlog rather than the old 24h slice.
- It is bounded, so the first run can't attempt to summarize an unbounded multi-month history
  (which would blow LLM cost and the `maxResults: 100` page cap). After the first successful
  run the watermark takes over and the fallback is never used again for that account.
- 72h matches the existing 3-day (`24 * 3`) re-send guard already used by the sibling summary
  feature (`apps/web/app/api/resend/summary/route.ts:169`), keeping the codebase's "recent
  window" convention consistent.

## Rejected alternatives

- **(B) Tie window to history catch-up span (`lastSyncedHistoryId`).** Gmail `historyId`s are
  opaque, monotonic IDs — not timestamps — and `messages.list` has no `historyId`-range query.
  You'd have to walk `history.list` to map an ID back to a time, adding a second API surface
  and failure mode (history is expired/pruned by Gmail after a period). Far more complex than a
  single persisted timestamp, for no gain. Reject.

- **(C) Widen fixed window to 72h + keep `--hours` configurable.** Simple, but a fixed window
  still loses any email older than the window when sleep gaps exceed it, and re-summarizes the
  overlap on every run (cost + duplicate digest entries). Strategy (A) makes (C)'s 72h the
  *fallback* only, getting (C)'s simplicity on first run while eliminating both the gap and the
  recurring overlap. Reject as the steady-state strategy; adopt its 72h value as the fallback.

## Summary for CU-1

1. Add `lastDigestSentAt DateTime?` to `EmailAccount` (`schema.prisma:~135`); migrate
   `add_last_digest_sent_at`.
2. In `dailySummary.ts`: select `lastDigestSentAt`; build
   `in:inbox after:${afterEpoch} -label:Marketing -label:Newsletter -label:Receipt -category:promotions`
   where `afterEpoch = floor((lastDigestSentAt ?? now-72h)/1000)`.
3. Keep `--hours` as a manual override (uses `newer_than:Nh`, does NOT advance the watermark).
4. After a successful `messages.send`, `update EmailAccount.lastDigestSentAt = new Date()` for
   the automatic path only.
5. Keep the existing `executedRule` filter (`dailySummary.ts:85-94`) for boundary-second dedup.
