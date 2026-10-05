import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSummarizeEmailForDigest } from "@/utils/ai/digest/summarize-email-for-digest";
import { queryBatchMessagesPages } from "@/utils/gmail/message";
import { sendDailySummary } from "./dailySummary";

const send = vi.fn();

// The script starts with `import "dotenv/config"`; keep the test off the real .env.
vi.mock("dotenv/config", () => ({}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findUnique: vi.fn(async () => ({
        id: "account-1",
        userId: "user-1",
        email: "me@example.com",
        lastDigestSentAt: null,
        user: { name: "Me" },
        account: {
          provider: "google",
          access_token: "access",
          refresh_token: "refresh",
          expires_at: null,
        },
      })),
      update: vi.fn(),
    },
    executedRule: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn(async () => ({
    users: { messages: { send } },
  })),
}));
vi.mock("@/utils/gmail/message", () => ({ queryBatchMessagesPages: vi.fn() }));
vi.mock("@/utils/ai/digest/summarize-email-for-digest", () => ({
  aiSummarizeEmailForDigest: vi.fn(),
}));
vi.mock("@/utils/get-email-from-message", () => ({
  getEmailForLLM: (message: { id: string }) => ({ id: message.id }),
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

const summarize = vi.mocked(aiSummarizeEmailForDigest);

function messages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    headers: {
      from: `Sender ${i} <s${i}@example.com>`,
      subject: `Subject ${i}`,
    },
  }));
}

/** The digest HTML is base64url inside the raw RFC 822 message passed to Gmail. */
function sentItems() {
  const raw = send.mock.calls[0][0].requestBody.raw as string;
  const html = Buffer.from(raw, "base64url").toString("utf8");
  const subjects = [...html.matchAll(/font-size:15px;">(.*?)<\/div>/g)].map(
    (m) => m[1],
  );
  const contents = [
    ...html.matchAll(/white-space:pre-line;">(.*?)<\/div>/g),
  ].map((m) => m[1]);
  return { subjects, contents };
}

describe("sendDailySummary summarization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs at most 4 summaries at once and keeps message order", async () => {
    const count = 12;
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(
      messages(count) as never,
    );
    let inFlight = 0;
    let maxInFlight = 0;
    summarize.mockImplementation(async ({ messageToSummarize }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Earlier messages finish later, so completion order is the reverse of input order.
      const index = Number(messageToSummarize.id.slice(1));
      await new Promise((resolve) => setTimeout(resolve, (count - index) * 5));
      inFlight--;
      return { content: `Summary ${index}` };
    });

    await sendDailySummary("me@example.com");

    expect(summarize).toHaveBeenCalledTimes(count);
    expect(maxInFlight).toBe(4);
    const { subjects, contents } = sentItems();
    expect(subjects).toEqual(
      Array.from({ length: count }, (_, i) => `Subject ${i}`),
    );
    expect(contents).toEqual(
      Array.from({ length: count }, (_, i) => `Summary ${i}`),
    );
  });

  it("keeps a fallback entry, in place, when a summary is null", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(3) as never);
    summarize.mockImplementation(async ({ messageToSummarize }) =>
      messageToSummarize.id === "m1" ? null : { content: "ok" },
    );

    await sendDailySummary("me@example.com");

    const { subjects, contents } = sentItems();
    expect(subjects).toEqual(["Subject 0", "Subject 1", "Subject 2"]);
    expect(contents[0]).toBe("ok");
    expect(contents[1]).toContain("Summary unavailable");
    expect(contents[2]).toBe("ok");
    expect(summarize).toHaveBeenCalledTimes(3); // null is not retried
  });

  it("retries a thrown summary once, then falls back", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(2) as never);
    summarize.mockImplementation(async ({ messageToSummarize }) => {
      if (messageToSummarize.id === "m0") throw new Error("boom");
      return { content: "ok" };
    });

    await sendDailySummary("me@example.com");

    expect(
      summarize.mock.calls.filter(([a]) => a.messageToSummarize.id === "m0"),
    ).toHaveLength(2); // initial attempt + one retry
    const { contents } = sentItems();
    expect(contents[0]).toContain("Summary unavailable");
    expect(contents[1]).toBe("ok");
  });
});
