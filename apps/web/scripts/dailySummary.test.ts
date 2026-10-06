import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSummarizeEmailForDigest } from "@/utils/ai/digest/summarize-email-for-digest";
import { getDigestTagCandidates } from "@/utils/ai/digest/digest-tags";
import { queryBatchMessagesPages } from "@/utils/gmail/message";
import prisma from "@/utils/prisma";
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
        rules: [],
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
vi.mock("@/utils/ai/digest/digest-tags", () => ({
  getDigestTagCandidates: vi.fn(() => ({ staticTags: [], aiCandidates: [] })),
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
const digestTags = vi.mocked(getDigestTagCandidates);

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
  // One <tr> per item; its chips are the <span>s between the sender line and the summary.
  const tags = html
    .split("<tr>")
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<span[^>]*>(.*?)<\/span>/g)].map((m) => m[1]),
    );
  const notice = html.match(/<p style="margin:16px[^>]*>(.*?)<\/p>/)?.[1];
  // One <h3> per tag group; the subjects after it (up to the next <h3>) belong to that group.
  const groups = html
    .split("<h3")
    .slice(1)
    .map((part) => ({
      header: part.match(/>(.*?)<\/h3>/)?.[1],
      subjects: [...part.matchAll(/font-size:15px;">(.*?)<\/div>/g)].map(
        (m) => m[1],
      ),
    }));
  return { subjects, contents, tags, notice, groups, html };
}

describe("sendDailySummary summarization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    digestTags.mockReturnValue({ staticTags: [], aiCandidates: [] });
  });

  it("runs at most 3 summaries at once and keeps message order", async () => {
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
    expect(maxInFlight).toBe(3);
    const { subjects, contents } = sentItems();
    expect(subjects).toEqual(
      Array.from({ length: count }, (_, i) => `Subject ${i}`),
    );
    expect(contents).toEqual(
      Array.from({ length: count }, (_, i) => `Summary ${i}`),
    );
  });

  it("renders a tag chip line per item: static and AI tags merged, deduped, escaped; the group tag is the header, not a chip", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(3) as never);
    digestTags.mockImplementation(({ message }) =>
      message.id === "m0"
        ? { staticTags: ["Tianguo Band"], aiCandidates: [] }
        : {
            staticTags: [],
            aiCandidates: [{ name: "Urgent", instructions: "u" }],
          },
    );
    summarize.mockImplementation(async ({ messageToSummarize }) => {
      if (messageToSummarize.id === "m0")
        return { content: "a", tags: ["Tianguo Band", "Urgent"] };
      if (messageToSummarize.id === "m1")
        return { content: "b", tags: ["R&D <b>"] };
      return { content: "c", tags: [] };
    });

    await sendDailySummary("me@example.com");

    const { groups, tags } = sentItems();
    // m0 is grouped under Urgent (its other tag, Tianguo Band, stays a chip); m1's only tag is its header.
    expect(groups).toEqual([
      { header: "Urgent (1)", subjects: ["Subject 0"] },
      { header: "R&amp;D &lt;b&gt; (1)", subjects: ["Subject 1"] },
      { header: "Untagged (1)", subjects: ["Subject 2"] },
    ]);
    expect(tags).toEqual([["Tianguo Band"], [], []]);
  });

  it("hands each message's AI candidates to the summariser", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(1) as never);
    const aiCandidates = [{ name: "Urgent", instructions: "u" }];
    digestTags.mockReturnValue({ staticTags: [], aiCandidates });
    summarize.mockResolvedValue({ content: "ok", tags: [] });

    await sendDailySummary("me@example.com");

    expect(summarize.mock.calls[0][0].tagCandidates).toBe(aiCandidates);
  });

  it("keeps the static tags on a fallback entry", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(1) as never);
    digestTags.mockReturnValue({
      staticTags: ["Tianguo Band"],
      aiCandidates: [],
    });
    summarize.mockResolvedValue(null);

    await sendDailySummary("me@example.com");

    const { contents, groups } = sentItems();
    expect(contents[0]).toContain("Summary unavailable");
    expect(groups.map((g) => g.header)).toEqual(["Tianguo Band (1)"]);
  });

  it("says which tags the truncated (+N more) items carry", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(
      messages(203) as never,
    );
    summarize.mockImplementation(async ({ messageToSummarize }) => {
      const i = Number(messageToSummarize.id.slice(1));
      return {
        content: "x",
        tags: i >= 201 ? ["Urgent"] : i === 200 ? ["Recruiters"] : [],
      };
    });

    await sendDailySummary("me@example.com");

    const { subjects, notice } = sentItems();
    expect(subjects).toHaveLength(200);
    expect(notice).toContain("+3 more emails not shown");
    expect(notice).toContain("Among them: Recruiters 1, Urgent 2.");
  });

  it("moves the watermark to when the window was read, and leaves out its own earlier digest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-10-05T21:00:00Z");
      vi.setSystemTime(t0);
      vi.mocked(queryBatchMessagesPages).mockImplementation(async () => {
        vi.setSystemTime(new Date(t0.getTime() + 5 * 60_000)); // summaries + send take minutes
        return messages(1) as never;
      });
      summarize.mockResolvedValue({ content: "ok", tags: [] });

      await sendDailySummary("me@example.com");

      expect(vi.mocked(prisma.emailAccount.update)).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastDigestSentAt: t0 } }),
      );
      const query = vi.mocked(queryBatchMessagesPages).mock.calls[0][1].query;
      expect(query).toContain('-subject:"Daily Inbox Digest"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not print the summariser's raw null answer", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(1) as never);
    summarize.mockResolvedValue({ content: "null", tags: ["Marketing"] });

    await sendDailySummary("me@example.com");

    const { contents, groups } = sentItems();
    expect(contents[0]).not.toMatch(/^\s*null\s*$/i);
    expect(groups.map((g) => g.header)).toEqual(["Marketing (1)"]);
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

describe("sendDailySummary grouping by tag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    digestTags.mockReturnValue({ staticTags: [], aiCandidates: [] });
  });

  /** The model returns `tagsByIndex[i]` as message i's tags (missing = no tags). */
  function tagSummaries(tagsByIndex: Record<number, string[]>) {
    summarize.mockImplementation(async ({ messageToSummarize }) => ({
      content: "x",
      tags: tagsByIndex[Number(messageToSummarize.id.slice(1))] ?? [],
    }));
  }

  it("puts a multi-tag email once, under its highest-priority tag, with the other tags as chips", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(1) as never);
    tagSummaries({ 0: ["Marketing", "Recruiters", "Urgent"] });

    await sendDailySummary("me@example.com");

    const { groups, tags, subjects } = sentItems();
    expect(groups).toEqual([{ header: "Urgent (1)", subjects: ["Subject 0"] }]);
    expect(subjects).toHaveLength(1);
    expect(tags).toEqual([["Marketing", "Recruiters"]]);
  });

  it("orders groups Urgent, Tianguo Band, Recruiters, the other listed tags, unlisted tags A-Z, then Untagged", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(9) as never);
    tagSummaries({
      0: [], // Untagged, received first but shown last
      1: ["Marketing"],
      2: ["Zeta"], // unlisted
      3: ["Dev"],
      4: ["Recruiters"],
      5: ["Alpha"], // unlisted
      6: ["Tianguo Band"],
      7: ["need an action"],
      8: ["Urgent"],
    });

    await sendDailySummary("me@example.com");

    expect(sentItems().groups.map((g) => g.header)).toEqual([
      "Urgent (1)",
      "Tianguo Band (1)",
      "Recruiters (1)",
      "need an action (1)",
      "Dev (1)",
      "Marketing (1)",
      "Alpha (1)",
      "Zeta (1)",
      "Untagged (1)",
    ]);
  });

  it("keeps the received order inside each group and drops or duplicates nothing", async () => {
    const count = 12;
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(
      messages(count) as never,
    );
    tagSummaries(
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          i,
          i % 3 === 0 ? ["Urgent"] : i % 3 === 1 ? ["Dev", "FYI"] : [],
        ]),
      ),
    );

    await sendDailySummary("me@example.com");

    const { groups, subjects } = sentItems();
    expect(groups).toEqual([
      {
        header: "Urgent (4)",
        subjects: ["Subject 0", "Subject 3", "Subject 6", "Subject 9"],
      },
      {
        header: "Dev (4)",
        subjects: ["Subject 1", "Subject 4", "Subject 7", "Subject 10"],
      },
      {
        header: "Untagged (4)",
        subjects: ["Subject 2", "Subject 5", "Subject 8", "Subject 11"],
      },
    ]);
    expect([...subjects].sort()).toEqual(
      Array.from({ length: count }, (_, i) => `Subject ${i}`).sort(),
    );
  });

  it("shows no group headers when no email has a tag, and omits empty groups", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(3) as never);
    tagSummaries({});

    await sendDailySummary("me@example.com");

    const { groups, subjects } = sentItems();
    expect(groups).toEqual([]);
    expect(subjects).toEqual(["Subject 0", "Subject 1", "Subject 2"]);
  });

  it("escapes a tag name used as a group header", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(1) as never);
    tagSummaries({ 0: ['<script>alert("x")</script>'] });

    await sendDailySummary("me@example.com");

    const { html, groups } = sentItems();
    expect(html).not.toContain("<script>");
    expect(groups[0].header).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; (1)",
    );
  });

  it("caps the received-order list first, then groups it; hidden emails stay listed by tag in the notice", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(
      messages(203) as never,
    );
    // The three hidden (oldest) emails are Urgent; the cap must not rescue them into the Urgent group.
    tagSummaries({
      0: ["Dev"],
      201: ["Urgent"],
      202: ["Urgent"],
      200: ["Urgent"],
    });

    await sendDailySummary("me@example.com");

    const { groups, subjects, notice } = sentItems();
    expect(subjects).toHaveLength(200);
    expect(subjects).not.toContain("Subject 200");
    expect(groups.map((g) => g.header)).toEqual(["Dev (1)", "Untagged (199)"]);
    expect(groups[1].subjects[0]).toBe("Subject 1");
    expect(notice).toContain("+3 more emails not shown");
    expect(notice).toContain("Among them: Urgent 3.");
  });

  it("groups a fallback entry by its static tags, else under Untagged", async () => {
    vi.mocked(queryBatchMessagesPages).mockResolvedValue(messages(3) as never);
    digestTags.mockImplementation(({ message }) => ({
      staticTags: message.id === "m1" ? ["Tianguo Band"] : [],
      aiCandidates: [],
    }));
    summarize.mockImplementation(async ({ messageToSummarize }) =>
      messageToSummarize.id === "m0" ? { content: "ok", tags: [] } : null,
    );

    await sendDailySummary("me@example.com");

    expect(sentItems().groups).toEqual([
      { header: "Tianguo Band (1)", subjects: ["Subject 1"] },
      { header: "Untagged (2)", subjects: ["Subject 0", "Subject 2"] },
    ]);
  });
});
