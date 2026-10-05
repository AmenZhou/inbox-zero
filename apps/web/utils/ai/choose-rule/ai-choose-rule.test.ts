import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import { aiChooseRule } from "@/utils/ai/choose-rule/ai-choose-rule";

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

vi.mock("@/utils/llms", () => ({
  createGenerateObject: mockCreateGenerateObject,
}));

const highEffortOptions = {
  openai: { forceReasoning: true, reasoningEffort: "high" },
};
const rules = [{ name: "Urgent", instructions: "Time-sensitive emails" }];
const email = getEmail({
  from: "a@example.com",
  subject: "Help",
  content: "Now",
});

describe("aiChooseRule reasoning effort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for high reasoning effort when choosing a single rule", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: { ruleName: "Urgent", noMatchFound: false, reasoning: "r" },
    });

    await aiChooseRule({ email, rules, emailAccount: getEmailAccount() });

    expect(
      mockCreateGenerateObject.mock.calls[0][0].modelOptions.providerOptions,
    ).toEqual(highEffortOptions);
    expect(mockGenerateObject.mock.calls[0][0].providerOptions).toEqual(
      highEffortOptions,
    );
  });

  it("asks for high reasoning effort when choosing multiple rules", async () => {
    mockGenerateObject.mockResolvedValueOnce({
      object: {
        matchedRules: [{ ruleName: "Urgent", isPrimary: true }],
        noMatchFound: false,
        reasoning: "r",
      },
    });

    await aiChooseRule({
      email,
      rules,
      emailAccount: getEmailAccount({ multiRuleSelectionEnabled: true }),
    });

    expect(
      mockCreateGenerateObject.mock.calls[0][0].modelOptions.providerOptions,
    ).toEqual(highEffortOptions);
    expect(mockGenerateObject.mock.calls[0][0].providerOptions).toEqual(
      highEffortOptions,
    );
  });
});
