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

export async function sendDailySummary(email: string, hours = 24) {
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

  const query = `in:inbox newer_than:${hours}h -label:Marketing -label:Newsletter -label:Receipt -category:promotions`;

  summaryLogger.info("Fetching inbox messages", { query });

  const messages = await queryBatchMessagesPages(gmail, {
    query,
    maxResults: 100,
  });

  summaryLogger.info("Fetched messages", { count: messages.length });

  if (messages.length === 0) {
    summaryLogger.info("No messages to summarize, skipping digest");
    return;
  }

  const emailAccountWithAI = {
    ...emailAccount,
    name: emailAccount.user.name,
  };

  const results = await Promise.allSettled(
    messages.map(async (message) => {
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
    total: messages.length,
    summarized: digestItems.length,
  });

  if (digestItems.length === 0) {
    summaryLogger.info("No summaries produced, skipping digest");
    return;
  }

  const date = new Date();
  const subject = `Daily Inbox Digest — ${date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`;
  const html = buildDigestHtml(digestItems, date);
  const raw = buildRawMessage({ to: email, from: email, subject, html });

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  summaryLogger.info("Digest email sent", { itemCount: digestItems.length });
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

  const hours = hoursArg
    ? Number.parseInt(
        hoursArg.split("=")[1] ?? hoursArg.split(" ")[1] ?? "24",
        10,
      )
    : 24;

  await sendDailySummary(emailArg, hours);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDigestHtml(items: DigestItem[], date: Date): string {
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

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#111;">
  <h2 style="margin:0 0 4px;font-size:20px;">Daily Inbox Digest</h2>
  <p style="margin:0 0 20px;color:#6b7280;font-size:14px;">${escapeHtml(dateStr)} &mdash; ${items.length} email${items.length === 1 ? "" : "s"}</p>
  <table style="width:100%;border-collapse:collapse;">${rows}</table>
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
