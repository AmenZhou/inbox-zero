import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import { aiDraftReply } from "@/utils/ai/reply/draft-reply";

const { mockCreateGenerateObject, mockGenerateObject } = vi.hoisted(() => {
  const mockGenerateObject = vi.fn();
  const mockCreateGenerateObject = vi.fn(
    (_options: { modelOptions: { providerOptions?: unknown } }) =>
      mockGenerateObject,
  );
  return { mockCreateGenerateObject, mockGenerateObject };
});

vi.mock("server-only", () => ({}));

// Keep the real withHighReasoningEffort; only the model selection is stubbed.
vi.mock("@/utils/llms/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/llms/model")>()),
  getModel: vi.fn(() => ({
    provider: "openai",
    modelName: "gpt-6-luna",
    model: {},
    providerOptions: { openai: { forceReasoning: true } },
    backupModel: null,
    hasUserApiKey: false,
  })),
}));

vi.mock("@/utils/llms/index", () => ({
  createGenerateObject: mockCreateGenerateObject,
}));

const highEffortOptions = {
  openai: { forceReasoning: true, reasoningEffort: "high" },
};

describe("aiDraftReply reasoning effort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for high reasoning effort when drafting a reply", async () => {
    mockGenerateObject.mockResolvedValueOnce({ object: { reply: "Sure." } });

    await aiDraftReply({
      messages: [
        {
          ...getEmail({
            from: "sender@example.com",
            subject: "Question",
            to: "user@example.com",
            content: "Can you help?",
          }),
          id: "msg-1",
        },
      ],
      emailAccount: getEmailAccount({ email: "user@example.com" }),
      knowledgeBaseContent: null,
      emailHistorySummary: null,
      emailHistoryContext: null,
      calendarAvailability: null,
      writingStyle: null,
      mcpContext: null,
      meetingContext: null,
    } as Parameters<typeof aiDraftReply>[0]);

    expect(
      mockCreateGenerateObject.mock.calls[0][0].modelOptions.providerOptions,
    ).toEqual(highEffortOptions);
    expect(mockGenerateObject.mock.calls[0][0].providerOptions).toEqual(
      highEffortOptions,
    );
  });
});
