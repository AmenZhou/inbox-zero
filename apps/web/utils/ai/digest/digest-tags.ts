import { SystemType } from "@/generated/prisma/enums";
import { evaluateRuleConditions } from "@/utils/ai/choose-rule/match-rules";
import type { Logger } from "@/utils/logger";
import { isConversationStatusType } from "@/utils/reply-tracker/conversation-status-config";
import type { ParsedMessage, RuleWithActions } from "@/utils/types";

export type DigestTagCandidate = { name: string; instructions: string };

/**
 * Splits the account's enabled rules into digest tags for one email.
 * - `staticTags`: rules with no instructions (the static-only rules, e.g. "Tianguo Band"), decided in code with
 *   the rules engine's own matcher. Exact and free.
 * - `aiCandidates`: rules with instructions, whose tag the summariser decides in its single call.
 * The tag is the rule's LABEL action label (the name the user sees in Gmail), not the rule name. Conversation
 * trackers and the cold-email blocker are skipped: they depend on thread history / a separate classifier.
 */
export function getDigestTagCandidates({
  rules,
  message,
  logger,
}: {
  rules: RuleWithActions[];
  message: ParsedMessage;
  logger: Logger;
}): { staticTags: string[]; aiCandidates: DigestTagCandidate[] } {
  const staticTags: string[] = [];
  const aiCandidates: DigestTagCandidate[] = [];

  for (const rule of rules) {
    if (
      isConversationStatusType(rule.systemType) ||
      rule.systemType === SystemType.COLD_EMAIL
    )
      continue;

    const label = rule.actions.find(
      (a) => a.type === "LABEL" && a.label,
    )?.label;
    if (!label) continue;

    const { matched, potentialAiMatch } = evaluateRuleConditions({
      rule,
      message,
      logger,
    });

    if (!rule.instructions) {
      if (matched && !staticTags.includes(label)) staticTags.push(label);
    } else if (matched || potentialAiMatch) {
      // Rules that have instructions are judged by the model even when a static part matched
      // (e.g. "from @upwork.com OR <description>"): the description says what the user means.
      aiCandidates.push({
        name: label,
        instructions: rule.instructions.replace(/\s+/g, " ").trim(),
      });
    }
  }

  return { staticTags, aiCandidates };
}
