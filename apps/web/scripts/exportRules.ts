// Run with: cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/exportRules.ts <email> [output.yaml]

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { stringify } from "yaml";
import prisma from "@/utils/prisma";

async function main() {
  const email = process.argv[2];
  const outputFile =
    process.argv[3] ||
    `inbox-zero-rules-${new Date().toISOString().split("T")[0]}.yaml`;

  if (!email) {
    console.error("Usage: exportRules.ts <email> [output.yaml]");
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

  const rules = await prisma.rule.findMany({
    where: { emailAccountId: emailAccount.id },
    include: { actions: true },
    orderBy: { createdAt: "asc" },
  });

  const exportData = rules.map((rule) => ({
    name: rule.name,
    instructions: rule.instructions,
    enabled: rule.enabled,
    automate: rule.automate,
    runOnThreads: rule.runOnThreads,
    systemType: rule.systemType,
    conditionalOperator: rule.conditionalOperator,
    from: rule.from,
    to: rule.to,
    subject: rule.subject,
    body: rule.body,
    categoryFilterType: rule.categoryFilterType,
    actions: rule.actions.map((action) => ({
      type: action.type,
      label: action.label,
      to: action.to,
      cc: action.cc,
      bcc: action.bcc,
      subject: action.subject,
      content: action.content,
      folderName: action.folderName,
      url: action.url,
      delayInMinutes: action.delayInMinutes,
    })),
  }));

  const outputPath = path.resolve(outputFile);
  fs.writeFileSync(outputPath, stringify(exportData));

  console.log(`Exported ${rules.length} rules to ${outputPath}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
