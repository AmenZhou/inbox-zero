// Run with: cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/dailySummary.ts user@example.com [--hours 48]

import "dotenv/config";
import prisma from "@/utils/prisma";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { queryBatchMessagesPages } from "@/utils/gmail/message";
import { aiSummarizeEmailForDigest } from "@/utils/ai/digest/summarize-email-for-digest";
import { extractNameFromEmail } from "@/utils/email";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("daily-summary");

type DigestItem = { from: string; subject: string; content: string };

// Fallback window used on first run / when the account has no `lastDigestSentAt`
// watermark yet (R-1 decision: docs/catch-up-summary-window.md).
const FALLBACK_HOURS = 72;

// Safety upper bound on how many inbox messages a single digest run will fetch.
// `queryBatchMessagesPages` treats its `maxResults` as a HARD cap on the total
// number of messages collected across all pages — NOT a per-page size. The old
// call site passed `100`, which silently dropped everything past the first 100
// whenever the backlog was larger (common after a multi-day gap, more so now that
// CU-1 widened the window to "since last digest"). We raise this to a value that
// comfortably exceeds a realistic multi-day backlog so the digest covers the full
// set, while still capping unbounded fetches. When this bound is actually hit we
// log a WARN with the count rather than silently truncating (CU-2).
const MAX_DIGEST_MESSAGES = 1000;

// Upper bound on how many summarized items we put into a single digest email.
// A very large item list can push the rendered HTML past Gmail's send-size limit
// and fail the whole send. To keep the digest reliable, we render at most this
// many items and append a visible "+N more" notice when the list is longer, so
// the email always sends and the truncation is observable (CU-2).
const MAX_DIGEST_ITEMS_PER_EMAIL = 200;

/**
 * Send the daily catch-up digest.
 *
 * @param email   the email account to summarize
 * @param hours   optional manual override. When provided, the window is a fixed
 *                `newer_than:${hours}h` slice and the per-account watermark is NOT
 *                advanced (ad-hoc runs must not move the watermark). When omitted,
 *                the automatic catch-up path covers everything since the last digest
 *                (`after:<lastDigestSentAt>`, falling back to 72h on first run) and
 *                advances `lastDigestSentAt` after a successful send.
 */
export async function sendDailySummary(email: string, hours?: number) {
  const summaryLogger = logger.with({ email, hours });

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      userId: true,
      email: true,
      about: true,
      multiRuleSelectionEnabled: true,
      timezone: true,
      calendarBookingLink: true,
      lastDigestSentAt: true,
      user: {
        select: {
          name: true,
          aiProvider: true,
          aiModel: true,
          aiApiKey: true,
        },
      },
      account: {
        select: {
          provider: true,
          access_token: true,
          refresh_token: true,
          expires_at: true,
        },
      },
    },
  });

  if (!emailAccount) {
    summaryLogger.error("Email account not found");
    return;
  }

  if (
    !emailAccount.account?.access_token ||
    !emailAccount.account?.refresh_token
  ) {
    summaryLogger.error("Missing Gmail tokens");
    return;
  }

  const gmail = await getGmailClientWithRefresh({
    accessToken: emailAccount.account.access_token,
    refreshToken: emailAccount.account.refresh_token,
    expiresAt: emailAccount.account.expires_at?.getTime() ?? null,
    emailAccountId: emailAccount.id,
    logger: summaryLogger,
  });

  // Resolve the time window once, up front.
  // - Manual override (`--hours` passed): fixed `newer_than:${hours}h` slice; does
  //   NOT advance the watermark.
  // - Automatic catch-up (no `--hours`): everything since the last successful digest
  //   (`after:<lastDigestSentAt>`), falling back to FALLBACK_HOURS on first run / null.
  const isManualOverride = hours !== undefined;
  const exclusions =
    "-label:Marketing -label:Newsletter -label:Receipt -category:promotions";

  let query: string;
  if (isManualOverride) {
    query = `in:inbox newer_than:${hours}h ${exclusions}`;
  } else {
    const now = Date.now();
    const sinceMs = emailAccount.lastDigestSentAt
      ? emailAccount.lastDigestSentAt.getTime()
      : now - FALLBACK_HOURS * 60 * 60 * 1000;
    // Gmail `after:` accepts Unix-epoch seconds.
    const afterEpoch = Math.floor(sinceMs / 1000);
    query = `in:inbox after:${afterEpoch} ${exclusions}`;
  }

  summaryLogger.info("Resolved digest window", {
    mode: isManualOverride ? "manual-override" : "since-last-digest",
    lastDigestSentAt: emailAccount.lastDigestSentAt ?? null,
    fallbackHours: isManualOverride ? null : FALLBACK_HOURS,
    query,
  });

  summaryLogger.info("Fetching inbox messages", {
    query,
    cap: MAX_DIGEST_MESSAGES,
  });

  // Fetch the FULL backlog for the window (up to the safety bound), not just the
  // first 100. `maxResults` here is a total-across-pages cap, so passing
  // MAX_DIGEST_MESSAGES lets the loop page through everything matching `query`.
  const messages = await queryBatchMessagesPages(gmail, {
    query,
    maxResults: MAX_DIGEST_MESSAGES,
  });

  // If we collected at least the cap, paging stopped at the bound and there may be
  // more unfetched messages — surface this rather than letting it pass silently.
  const capHit = messages.length >= MAX_DIGEST_MESSAGES;

  summaryLogger.info("Fetched messages", {
    fetched: messages.length,
    cap: MAX_DIGEST_MESSAGES,
    capHit,
  });

  if (capHit) {
    summaryLogger.warn(
      "Digest fetch hit the MAX_DIGEST_MESSAGES safety bound; backlog may be truncated",
      { fetched: messages.length, cap: MAX_DIGEST_MESSAGES },
    );
  }

  if (messages.length === 0) {
    summaryLogger.info("No messages to summarize, skipping digest");
    return;
  }

  // Filter to only emails not yet processed by the rules engine
  const processedRules = await prisma.executedRule.findMany({
    where: {
      emailAccountId: emailAccount.id,
      messageId: { in: messages.map((m) => m.id) },
    },
    select: { messageId: true },
  });
  const processedIds = new Set(processedRules.map((r) => r.messageId));
  const unprocessedMessages = messages.filter((m) => !processedIds.has(m.id));

  summaryLogger.info("Filtered to unprocessed messages", {
    total: messages.length,
    unprocessed: unprocessedMessages.length,
  });

  if (unprocessedMessages.length === 0) {
    summaryLogger.info("No unprocessed messages, skipping digest");
    return;
  }

  const emailAccountWithAI = {
    ...emailAccount,
    name: emailAccount.user.name,
  };

  const results = await Promise.allSettled(
    unprocessedMessages.map(async (message) => {
      const emailForLLM = getEmailForLLM(message);
      const summary = await aiSummarizeEmailForDigest({
        ruleName: "Daily Digest",
        emailAccount: emailAccountWithAI,
        messageToSummarize: emailForLLM,
      });

      if (!summary) return null;

      return {
        from: extractNameFromEmail(message.headers.from),
        subject: message.headers.subject,
        content: summary.content,
      };
    }),
  );

  const digestItems = results
    .filter(
      (r): r is PromiseFulfilledResult<DigestItem> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);

  summaryLogger.info("Summarized messages", {
    total: unprocessedMessages.length,
    summarized: digestItems.length,
  });

  if (digestItems.length === 0) {
    summaryLogger.info("No summaries produced, skipping digest");
    return;
  }

  // Guard the rendered email against Gmail's send-size limit: a very large item
  // list can produce HTML big enough to fail the send outright. We truncate to
  // MAX_DIGEST_ITEMS_PER_EMAIL and pass the omitted count so the email shows a
  // visible "+N more" notice — the send always succeeds and the truncation is
  // observable (CU-2). This is independent of the fetch-side MAX_DIGEST_MESSAGES.
  const renderedItems = digestItems.slice(0, MAX_DIGEST_ITEMS_PER_EMAIL);
  const omittedItemCount = digestItems.length - renderedItems.length;

  if (omittedItemCount > 0) {
    summaryLogger.warn(
      "Digest item list exceeds per-email render limit; truncating with notice",
      {
        total: digestItems.length,
        rendered: renderedItems.length,
        omitted: omittedItemCount,
        limit: MAX_DIGEST_ITEMS_PER_EMAIL,
      },
    );
  }

  const date = new Date();
  const subject = `Daily Inbox Digest - ${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`;
  const html = buildDigestHtml(renderedItems, date, omittedItemCount);
  const raw = buildRawMessage({ to: email, from: email, subject, html });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  summaryLogger.info("Digest email sent", {
    itemCount: renderedItems.length,
    totalItems: digestItems.length,
    omittedItems: omittedItemCount,
    largeDigestHandling: "truncate-with-notice",
  });

  // Advance the watermark ONLY after a successful send, and ONLY on the automatic
  // catch-up path. Manual `--hours` runs must not move the watermark.
  if (!isManualOverride) {
    await prisma.emailAccount.update({
      where: { id: emailAccount.id },
      data: { lastDigestSentAt: new Date() },
    });
    summaryLogger.info("Advanced lastDigestSentAt watermark");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const emailArg = args.find((a) => !a.startsWith("--"));
  const hoursArg = args.find((a) => a.startsWith("--hours"));

  if (!emailArg) {
    console.error(
      "Usage: npx tsx scripts/dailySummary.ts <email> [--hours <n>]",
    );
    process.exit(1);
  }

  // Only pass `hours` when `--hours` is explicitly provided. With no override the
  // script uses the automatic since-last-digest window (R-1 Strategy A).
  const hours = hoursArg
    ? Number.parseInt(
        hoursArg.split("=")[1] ?? hoursArg.split(" ")[1] ?? "24",
        10,
      )
    : undefined;

  await sendDailySummary(emailArg, hours);
}

// Only run main() when executed directly, not when imported by another script
if (process.argv[1]?.endsWith("dailySummary.ts")) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDigestHtml(
  items: DigestItem[],
  date: Date,
  omittedItemCount = 0,
): string {
  const dateStr = date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const rows = items
    .map(
      (item) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;color:#111;font-size:15px;">${escapeHtml(item.subject)}</div>
        <div style="color:#6b7280;font-size:13px;margin:2px 0 8px;">${escapeHtml(item.from)}</div>
        <div style="color:#374151;font-size:14px;white-space:pre-line;">${escapeHtml(item.content)}</div>
      </td>
    </tr>`,
    )
    .join("");

  const moreNotice =
    omittedItemCount > 0
      ? `<p style="margin:16px 0 0;color:#6b7280;font-size:13px;font-style:italic;">+${omittedItemCount} more email${omittedItemCount === 1 ? "" : "s"} not shown (digest truncated to keep this email a sendable size).</p>`
      : "";

  const countLabel = omittedItemCount > 0 ? items.length + omittedItemCount : items.length;

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111;">
  <h2 style="margin:0 0 4px;font-size:20px;">Daily Inbox Digest</h2>
  <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${escapeHtml(dateStr)} - ${countLabel} email${countLabel === 1 ? "" : "s"}</p>
  <table style="width:100%;border-collapse:collapse;">${rows}</table>
  ${moreNotice}
</body>
</html>`;
}

function buildRawMessage({
  to,
  from,
  subject,
  html,
}: {
  to: string;
  from: string;
  subject: string;
  html: string;
}): string {
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
