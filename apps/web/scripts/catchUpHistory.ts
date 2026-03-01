// Run with: cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/catchUpHistory.ts [email] [--send-summary]

import "dotenv/config";
import prisma from "@/utils/prisma";
import { sendDailySummary } from "./dailySummary";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getHistory } from "@/utils/gmail/history";
import {
  processHistory,
  updateLastSyncedHistoryId,
} from "@/app/api/google/webhook/process-history";
import {
  validateWebhookAccount,
  getWebhookEmailAccount,
} from "@/utils/webhook/validate-webhook-account";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("catch-up-history");

async function catchUpAccount(email: string) {
  const accountLogger = logger.with({ email });

  const emailAccount = await getWebhookEmailAccount({ email }, accountLogger);
  const validation = await validateWebhookAccount(emailAccount, accountLogger);

  if (!validation.success) {
    accountLogger.info("Account validation failed, skipping");
    return { status: "skipped" };
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
    accountLogger.error("Missing tokens after validation");
    return { status: "skipped" };
  }

  const gmail = await getGmailClientWithRefresh({
    accessToken: validatedAccount.account.access_token,
    refreshToken: validatedAccount.account.refresh_token,
    expiresAt: validatedAccount.account.expires_at?.getTime() || null,
    emailAccountId: validatedAccount.id,
    logger: accountLogger,
  });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const currentHistoryId = profile.data.historyId;

  if (!currentHistoryId) {
    accountLogger.warn("No historyId from Gmail profile");
    return { status: "skipped" };
  }

  const startHistoryId = validatedAccount.lastSyncedHistoryId;
  if (!startHistoryId) {
    accountLogger.warn("No lastSyncedHistoryId in database");
    return { status: "skipped" };
  }

  accountLogger.info("Catching up history", {
    startHistoryId,
    currentHistoryId,
  });

  let pageToken: string | undefined;
  let pagesProcessed = 0;
  let totalItems = 0;

  try {
    do {
      const data = await getHistory(gmail, {
        startHistoryId,
        historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
        maxResults: 500,
        pageToken,
      });

      pagesProcessed++;

      if (data.history?.length) {
        totalItems += data.history.length;

        await processHistory(
          {
            history: data.history,
            gmail,
            accessToken: validatedAccount.account.access_token,
            hasAutomationRules,
            hasAiAccess,
            rules: validatedAccount.rules,
            emailAccount: {
              ...validatedAccount,
              account: {
                provider: validatedAccount.account.provider || "google",
              },
            },
          },
          accountLogger,
        );
      }

      pageToken = data.nextPageToken ?? undefined;

      accountLogger.info("Processed history page", {
        page: pagesProcessed,
        itemsOnPage: data.history?.length ?? 0,
        hasMore: !!pageToken,
      });
    } while (pageToken);
  } catch (error) {
    if (isHistoryIdExpiredError(error)) {
      accountLogger.warn("History ID expired, resetting to current", {
        expiredHistoryId: startHistoryId,
        newHistoryId: currentHistoryId,
      });
      await updateLastSyncedHistoryId({
        emailAccountId: validatedAccount.id,
        lastSyncedHistoryId: currentHistoryId,
      });
      return {
        status: "expired_reset",
        pagesProcessed,
        itemsProcessed: totalItems,
      };
    }
    throw error;
  }

  if (totalItems === 0) {
    await updateLastSyncedHistoryId({
      emailAccountId: validatedAccount.id,
      lastSyncedHistoryId: currentHistoryId,
    });
  }

  return { status: "ok", pagesProcessed, itemsProcessed: totalItems };
}

function isHistoryIdExpiredError(error: unknown): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: simple
  const err = error as any;
  const statusCode =
    err.response?.data?.error?.code ??
    err.response?.status ??
    err.status ??
    err.code;

  return statusCode === 404;
}

async function main() {
  const sendSummary = process.argv.includes("--send-summary");
  const emailFilter =
    process.argv.find(
      (a, i) => i >= 2 && !a.startsWith("--") && a !== process.argv[1],
    ) || null;

  const whereClause = {
    lastSyncedHistoryId: { not: null as string | null },
    account: {
      provider: "google",
      access_token: { not: null as string | null },
      refresh_token: { not: null as string | null },
      disconnectedAt: null,
    },
    ...(emailFilter ? { email: emailFilter.toLowerCase() } : {}),
  };

  const emailAccounts = await prisma.emailAccount.findMany({
    where: whereClause,
    select: { id: true, email: true },
  });

  logger.info("Starting catch-up", { accountCount: emailAccounts.length });

  const results: Array<{
    email: string;
    status: string;
    itemsProcessed?: number;
    pagesProcessed?: number;
    error?: string;
  }> = [];

  for (const account of emailAccounts) {
    try {
      const result = await catchUpAccount(account.email);
      results.push({ email: account.email, ...result });
    } catch (error) {
      logger.error("Failed to catch up account", {
        email: account.email,
        error,
      });
      results.push({
        email: account.email,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  console.log(JSON.stringify({ accounts: results }, null, 2));

  if (sendSummary && emailFilter) {
    logger.info("Sending daily summary", { email: emailFilter });
    await sendDailySummary(emailFilter);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
