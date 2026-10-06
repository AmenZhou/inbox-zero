import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The script runs main() on import, so each test sets argv, imports it fresh and waits for the disconnect.
vi.mock("dotenv/config", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: { findMany: vi.fn(async () => []) },
    $disconnect: vi.fn(async () => {}),
  },
}));
vi.mock("./dailySummary", () => ({ sendDailySummary: vi.fn() }));
vi.mock("@/utils/gmail/client", () => ({ getGmailClientWithRefresh: vi.fn() }));
vi.mock("@/utils/gmail/history", () => ({ getHistory: vi.fn() }));
vi.mock("@/app/api/google/webhook/process-history", () => ({
  processHistory: vi.fn(),
  updateLastSyncedHistoryId: vi.fn(),
}));
vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  validateWebhookAccount: vi.fn(),
  getWebhookEmailAccount: vi.fn(),
}));
vi.mock("@/utils/logger", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    with: () => logger,
  };
  return { createScopedLogger: () => logger };
});

const originalArgv = process.argv;

async function runScript(...args: string[]) {
  vi.resetModules();
  process.argv = ["node", "scripts/catchUpHistory.ts", ...args];
  const prisma = (await import("@/utils/prisma")).default;
  vi.mocked(prisma.$disconnect).mockClear();
  await import("./catchUpHistory");
  await vi.waitFor(() => {
    if (!vi.mocked(prisma.$disconnect).mock.calls.length)
      throw new Error("script still running");
  });
  return {
    prisma,
    sendDailySummary: (await import("./dailySummary")).sendDailySummary,
    getWebhookEmailAccount: (
      await import("@/utils/webhook/validate-webhook-account")
    ).getWebhookEmailAccount,
    getHistory: (await import("@/utils/gmail/history")).getHistory,
    process: await import("@/app/api/google/webhook/process-history"),
  };
}

describe("catchUpHistory.ts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("--summary-only sends the digest and skips the whole Gmail catch-up", async () => {
    const r = await runScript("me@example.com", "--summary-only");

    expect(r.sendDailySummary).toHaveBeenCalledExactlyOnceWith(
      "me@example.com",
    );
    expect(r.prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(r.getWebhookEmailAccount).not.toHaveBeenCalled();
    expect(r.getHistory).not.toHaveBeenCalled();
    expect(r.process.processHistory).not.toHaveBeenCalled();
    expect(r.process.updateLastSyncedHistoryId).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("--summary-only wins over --send-summary (still no catch-up)", async () => {
    const r = await runScript(
      "me@example.com",
      "--send-summary",
      "--summary-only",
    );

    expect(r.sendDailySummary).toHaveBeenCalledTimes(1);
    expect(r.prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(r.getHistory).not.toHaveBeenCalled();
  });

  it("--summary-only without an email fails (exit 1) and does nothing", async () => {
    const r = await runScript("--summary-only");

    expect(r.sendDailySummary).not.toHaveBeenCalled();
    expect(r.prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("an unknown or mistyped flag fails closed: no digest, no catch-up", async () => {
    const r = await runScript("me@example.com", "--summary-onyl");

    expect(r.sendDailySummary).not.toHaveBeenCalled();
    expect(r.prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(r.getHistory).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("--send-summary alone keeps the old behaviour: digest, then the catch-up loop", async () => {
    const r = await runScript("me@example.com", "--send-summary");

    expect(r.sendDailySummary).toHaveBeenCalledWith("me@example.com");
    expect(r.prisma.emailAccount.findMany).toHaveBeenCalledTimes(1);
  });
});
