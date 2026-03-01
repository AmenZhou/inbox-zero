// Run with: cd apps/web && NODE_ENV=production npx tsx -r ./scripts/stub-server-only.cjs scripts/deleteRules.ts <email> <rule1> [rule2 ...]

import "dotenv/config";
import prisma from "@/utils/prisma";

async function main() {
  const email = process.argv[2];
  const names = process.argv.slice(3);

  if (!email || names.length === 0) {
    console.error("Usage: deleteRules.ts <email> <rule1> [rule2 ...]");
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

  const result = await prisma.rule.deleteMany({
    where: { emailAccountId: emailAccount.id, name: { in: names } },
  });

  console.log(`Deleted ${result.count} rule(s): ${names.join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
