import { describe, expect, it, vi } from "vitest";
import { getDigestTagCandidates } from "@/utils/ai/digest/digest-tags";
import { createScopedLogger } from "@/utils/logger";
import type { ParsedMessage, RuleWithActions } from "@/utils/types";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const logger = createScopedLogger("test");

function rule(overrides: Partial<RuleWithActions>): RuleWithActions {
  return {
    id: "r",
    name: "Rule",
    enabled: true,
    systemType: null,
    conditionalOperator: "AND",
    instructions: null,
    from: null,
    to: null,
    subject: null,
    body: null,
    groupId: null,
    actions: [{ id: "a", type: "LABEL", label: "Tag" }],
    ...overrides,
  } as unknown as RuleWithActions;
}

function message(headers: Partial<ParsedMessage["headers"]>): ParsedMessage {
  return {
    id: "m",
    textPlain: "",
    headers: { from: "a@x.test", to: "me@x.test", subject: "Hi", ...headers },
  } as ParsedMessage;
}

const band = (id: string, fields: Partial<RuleWithActions>) =>
  rule({
    id,
    name: `Tianguo Band - ${id}`,
    actions: [{ id: id, type: "LABEL", label: "Tianguo Band" }] as never,
    ...fields,
  });
const bandRules = [
  band("Recipient", { to: "ny-tianguo-band-*@googlegroups.com|@tianguo.band" }),
  band("Sender", { from: "@tianguo.band" }),
  band("Subject", { subject: "天国乐团|Tianguo|TianGuo" }),
];

describe("getDigestTagCandidates", () => {
  it("tags static-only rules in code, once per label", () => {
    const result = getDigestTagCandidates({
      rules: bandRules,
      message: message({
        from: "Admin <admin@tianguo.band>",
        subject: "Tianguo rehearsal",
      }),
      logger,
    });
    expect(result.staticTags).toEqual(["Tianguo Band"]);
    expect(result.aiCandidates).toEqual([]);
  });

  it("does not tag a static rule that does not match", () => {
    const result = getDigestTagCandidates({
      rules: bandRules,
      message: message({ from: "shop@store.test", subject: "Order shipped" }),
      logger,
    });
    expect(result.staticTags).toEqual([]);
  });

  it("offers rules with instructions to the model, with whitespace collapsed", () => {
    const result = getDigestTagCandidates({
      rules: [
        rule({
          name: "Urgent",
          instructions: "Time-sensitive\n\n  emails",
          actions: [{ id: "a", type: "LABEL", label: "Urgent" }] as never,
        }),
      ],
      message: message({}),
      logger,
    });
    expect(result.aiCandidates).toEqual([
      { name: "Urgent", instructions: "Time-sensitive emails" },
    ]);
    expect(result.staticTags).toEqual([]);
  });

  it("offers an OR static+AI rule to the model even when its static part matched", () => {
    const result = getDigestTagCandidates({
      rules: [
        rule({
          conditionalOperator: "OR",
          from: "@upwork.com",
          instructions: "Contract messages",
        }),
      ],
      message: message({ from: "Upwork <no-reply@upwork.com>" }),
      logger,
    });
    expect(result.staticTags).toEqual([]);
    expect(result.aiCandidates).toHaveLength(1);
  });

  it("skips an AND static+AI rule whose static part failed", () => {
    const result = getDigestTagCandidates({
      rules: [
        rule({ subject: "[mtcommunity]", instructions: "Community posts" }),
      ],
      message: message({ subject: "Hello" }),
      logger,
    });
    expect(result.aiCandidates).toEqual([]);
  });

  it("skips conversation trackers, the cold-email blocker and rules without a label", () => {
    const result = getDigestTagCandidates({
      rules: [
        rule({ systemType: "TO_REPLY", instructions: "Needs reply" }),
        rule({ systemType: "COLD_EMAIL", instructions: "Cold" }),
        rule({ instructions: "No label", actions: [] as never }),
        rule({
          instructions: "Archive only",
          actions: [{ id: "a", type: "ARCHIVE", label: null }] as never,
        }),
      ],
      message: message({}),
      logger,
    });
    expect(result).toEqual({ staticTags: [], aiCandidates: [] });
  });
});
