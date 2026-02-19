import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import prisma from "@/utils/prisma";
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
import type { Logger } from "@/utils/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = withError("cron/catch-up-history", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized request: api/cron/catch-up-history"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const emailFilter = url.searchParams.get("email");

  const result = await catchUpHistory(emailFilter, request.logger);

  return NextResponse.json(result);
});

async function catchUpHistory(emailFilter: string | null, logger: Logger) {
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
    const accountLogger = logger.with({
      email: account.email,
      emailAccountId: account.id,
    });

    try {
      const result = await catchUpAccount(account.email, accountLogger);
      results.push({ email: account.email, ...result });
    } catch (error) {
      captureException(error, { userEmail: account.email });
      accountLogger.error("Failed to catch up account", { error });
      results.push({
        email: account.email,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return { accounts: results };
}

async function catchUpAccount(email: string, logger: Logger) {
  const emailAccount = await getWebhookEmailAccount({ email }, logger);
  const validation = await validateWebhookAccount(emailAccount, logger);

  if (!validation.success) {
    logger.info("Account validation failed, skipping");
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
    logger.error("Missing tokens after validation");
    return { status: "skipped" };
  }

  const gmail = await getGmailClientWithRefresh({
    accessToken: validatedAccount.account.access_token,
    refreshToken: validatedAccount.account.refresh_token,
    expiresAt: validatedAccount.account.expires_at?.getTime() || null,
    emailAccountId: validatedAccount.id,
    logger,
  });

  const profile = await gmail.users.getProfile({ userId: "me" });
  const currentHistoryId = profile.data.historyId;

  if (!currentHistoryId) {
    logger.warn("No historyId from Gmail profile");
    return { status: "skipped" };
  }

  const startHistoryId = validatedAccount.lastSyncedHistoryId;
  if (!startHistoryId) {
    logger.warn("No lastSyncedHistoryId in database");
    return { status: "skipped" };
  }

  logger.info("Catching up history", {
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
          logger,
        );
      }

      pageToken = data.nextPageToken ?? undefined;

      logger.info("Processed history page", {
        page: pagesProcessed,
        itemsOnPage: data.history?.length ?? 0,
        hasMore: !!pageToken,
      });
    } while (pageToken);
  } catch (error) {
    if (isHistoryIdExpiredError(error)) {
      logger.warn("History ID expired, resetting to current", {
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
