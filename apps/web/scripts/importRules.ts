// Run with: cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/importRules.ts <email> <rules.yaml>

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import prisma from "@/utils/prisma";

type RuleAction = {
  type: string;
  label?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  content?: string | null;
  folderName?: string | null;
  url?: string | null;
  delayInMinutes?: number | null;
};

async function main() {
  const email = process.argv[2];
  const inputFile = process.argv[3];

  if (!email || !inputFile) {
    console.error("Usage: importRules.ts <email> <rules.yaml>");
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true },
  });

  if (!emailAccount) {
    console.error(`No account found for email: ${email}`);
    process.exit(1);
  }

  const text = fs.readFileSync(inputPath, "utf-8");
  const rules = parse(text);

  if (!Array.isArray(rules) || rules.length === 0) {
    console.error("Invalid or empty rules file");
    process.exit(1);
  }

  const existingRules = await prisma.rule.findMany({
    where: { emailAccountId: emailAccount.id },
    select: { id: true, name: true, systemType: true },
  });

  const rulesByName = new Map(
    existingRules.map((r) => [r.name.toLowerCase(), r.id]),
  );
  const rulesBySystemType = new Map(
    existingRules.filter((r) => r.systemType).map((r) => [r.systemType!, r.id]),
  );

  let createdCount = 0;
  let updatedCount = 0;

  for (const rule of rules) {
    const existingRuleId = rule.systemType
      ? rulesBySystemType.get(rule.systemType)
      : rulesByName.get(rule.name.toLowerCase());

    const mappedActions = (rule.actions as RuleAction[]).map((action) => ({
      type: action.type,
      label: action.label ?? null,
      labelId: null,
      subject: action.subject ?? null,
      content: action.content ?? null,
      to: action.to ?? null,
      cc: action.cc ?? null,
      bcc: action.bcc ?? null,
      folderName: action.folderName ?? null,
      folderId: null,
      url: action.url ?? null,
      delayInMinutes: action.delayInMinutes ?? null,
    }));

    if (existingRuleId) {
      await prisma.rule.update({
        where: { id: existingRuleId },
        data: {
          instructions: rule.instructions,
          enabled: rule.enabled ?? true,
          automate: rule.automate ?? true,
          runOnThreads: rule.runOnThreads ?? false,
          conditionalOperator: rule.conditionalOperator,
          categoryFilterType: rule.categoryFilterType ?? null,
          from: rule.from ?? null,
          to: rule.to ?? null,
          subject: rule.subject ?? null,
          body: rule.body ?? null,
          groupId: null,
          actions: {
            deleteMany: {},
            createMany: { data: mappedActions },
          },
        },
      });
      updatedCount++;
      console.log(`Updated: ${rule.name}`);
    } else {
      await prisma.rule.create({
        data: {
          emailAccountId: emailAccount.id,
          name: rule.name,
          systemType: rule.systemType ?? null,
          instructions: rule.instructions,
          enabled: rule.enabled ?? true,
          automate: rule.automate ?? true,
          runOnThreads: rule.runOnThreads ?? false,
          conditionalOperator: rule.conditionalOperator,
          categoryFilterType: rule.categoryFilterType ?? null,
          from: rule.from ?? null,
          to: rule.to ?? null,
          subject: rule.subject ?? null,
          body: rule.body ?? null,
          actions: {
            createMany: { data: mappedActions },
          },
        },
      });
      createdCount++;
      console.log(`Created: ${rule.name}`);
    }
  }

  console.log(`\nDone — created: ${createdCount}, updated: ${updatedCount}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
