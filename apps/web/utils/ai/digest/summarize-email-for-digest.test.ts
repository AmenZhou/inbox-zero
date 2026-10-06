import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiSummarizeEmailForDigest } from "@/utils/ai/digest/summarize-email-for-digest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/llms/model", () => ({ getModel: vi.fn(() => ({})) }));

const generateObject = vi.fn();
vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(() => generateObject),
}));

const emailAccount = {
  id: "account-1",
  userId: "user-1",
  email: "me@example.com",
  name: "Me",
  about: null,
  user: {},
} as never;
const messageToSummarize = {
  id: "m1",
  from: "Sender <s@example.com>",
  subject: "Hello",
  content: "Body",
} as never;

const candidates = [
  { name: "Urgent", instructions: "Time-sensitive emails" },
  { name: "Recruiters", instructions: "Job offers from recruiters" },
  { name: "FYI", instructions: "Things to know" },
];

function run(tagCandidates?: typeof candidates) {
  return aiSummarizeEmailForDigest({
    ruleName: "Daily Digest",
    emailAccount,
    messageToSummarize,
    tagCandidates,
  });
}

describe("aiSummarizeEmailForDigest tags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the { content } shape and the old prompt when no candidates are passed", async () => {
    generateObject.mockResolvedValue({ object: { content: "Summary" } });

    const result = await run();

    expect(result).toEqual({ content: "Summary" });
    expect(result).not.toHaveProperty("tags");
    const call = generateObject.mock.calls[0][0];
    expect(call.system).not.toContain("user_tags");
    expect(Object.keys(call.schema.shape)).toEqual(["content"]);
  });

  it("puts every candidate in the prompt and asks for tags in the same call", async () => {
    generateObject.mockResolvedValue({
      object: { content: "Summary", tags: ["Urgent"] },
    });

    await run(candidates);

    expect(generateObject).toHaveBeenCalledTimes(1);
    const call = generateObject.mock.calls[0][0];
    expect(Object.keys(call.schema.shape)).toEqual(["content", "tags"]);
    for (const c of candidates) {
      expect(call.system).toContain(`<name>${c.name}</name>`);
      expect(call.system).toContain(`<criteria>${c.instructions}</criteria>`);
    }
  });

  it("drops invented tags, fixes case, dedupes, and returns candidate order", async () => {
    generateObject.mockResolvedValue({
      object: {
        content: "Summary",
        tags: ["recruiters", "Made Up", " URGENT ", "Urgent", "VIP"],
      },
    });

    const result = await run(candidates);

    expect(result).toEqual({
      content: "Summary",
      tags: ["Urgent", "Recruiters"],
    });
  });

  it("returns an empty tag list when the model returns none", async () => {
    generateObject.mockResolvedValue({ object: { content: "S", tags: [] } });
    expect(await run(candidates)).toEqual({ content: "S", tags: [] });
  });

  it("returns null when the call fails, so the caller can fall back", async () => {
    generateObject.mockRejectedValue(new Error("boom"));
    expect(await run(candidates)).toBeNull();
  });
});
