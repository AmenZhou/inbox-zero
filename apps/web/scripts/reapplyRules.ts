// Re-applies the current rules to inbox emails from the last N hours.
// Clears existing executedRule records for those messages so the engine re-evaluates them.
//
// Run with:
//   cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/reapplyRules.ts <email> [--hours N]
// Default: last 24 hours. Use --hours 48 for a wider window.

import "dotenv/config";
import prisma from "@/utils/prisma";
import { getMessages } from "@/utils/gmail/message";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { createEmailProvider } from "@/utils/email/provider";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("reapply-rules");

async function main() {
  const email = process.argv[2];
  const hoursIdx = process.argv.indexOf("--hours");
  const hours =
    hoursIdx !== -1 ? Number.parseInt(process.argv[hoursIdx + 1], 10) : 24;

  if (!email) {
    console.error("Usage: reapplyRules.ts <email> [--hours N]");
    process.exit(1);
  }

  const accountLogger = logger.with({ email });

  const emailAccount = await getWebhookEmailAccount({ email }, accountLogger);
  const validation = await validateWebhookAccount(emailAccount, accountLogger);

  if (!validation.success) {
    accountLogger.error("Account validation failed, aborting");
    process.exit(1);
  }

  const {
    emailAccount: validatedAccount,
    hasAutomationRules,
    hasAiAccess,
  } = validation.data;

  if (
    !validatedAccount.account?.access_token ||
    !validatedAccount.account?.refresh_token
  ) {
    accountLogger.error("Missing OAuth tokens");
    process.exit(1);
  }

  // Build Gmail query: inbox messages received in the last N hours
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${since.getFullYear()}/${pad(since.getMonth() + 1)}/${pad(since.getDate())}`;
  const query = `in:inbox after:${dateStr}`;

  accountLogger.info("Fetching inbox messages", { query, hours });

  const gmail = await getGmailClientWithRefresh({
    accessToken: validatedAccount.account.access_token,
    refreshToken: validatedAccount.account.refresh_token,
    expiresAt: validatedAccount.account.expires_at?.getTime() ?? null,
    emailAccountId: validatedAccount.id,
    logger: accountLogger,
  });

  const allMessages: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;

  do {
    const result = await getMessages(gmail, {
      query,
      maxResults: 500,
      pageToken,
    });
    allMessages.push(...result.messages);
    pageToken = result.nextPageToken;
  } while (pageToken);

  accountLogger.info("Messages found", { count: allMessages.length });

  if (allMessages.length === 0) {
    console.log("No inbox messages found for the given window.");
    return;
  }

  // Clear existing executedRule records so processHistoryItem won't skip them
  const messageIds = allMessages.map((m) => m.id);
  const deleted = await prisma.executedRule.deleteMany({
    where: {
      emailAccountId: validatedAccount.id,
      messageId: { in: messageIds },
    },
  });
  accountLogger.info("Cleared prior rule executions", {
    cleared: deleted.count,
  });

  const provider = await createEmailProvider({
    emailAccountId: validatedAccount.id,
    provider: validatedAccount.account.provider ?? "google",
    logger: accountLogger,
  });

  const sharedEmailAccount = {
    ...validatedAccount,
    account: {
      provider: validatedAccount.account.provider ?? "google",
    },
  };

  let processed = 0;
  let errors = 0;

  for (const { id: messageId, threadId } of allMessages) {
    const msgLogger = accountLogger.with({ messageId });
    try {
      await processHistoryItem(
        { messageId, threadId },
        {
          provider,
          emailAccount: sharedEmailAccount,
          hasAutomationRules,
          hasAiAccess,
          rules: validatedAccount.rules,
          logger: msgLogger,
        },
      );
      processed++;
    } catch (error) {
      msgLogger.error("Error processing message", { error });
      errors++;
    }
  }

  console.log(
    JSON.stringify({ total: allMessages.length, processed, errors }, null, 2),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
