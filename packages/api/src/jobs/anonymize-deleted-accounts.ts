import { prisma } from '@ev-charger/shared';

async function main() {
  console.warn('[anonymize-deleted-accounts] Skipped: current Prisma schema has no deletionRequestedAt field on User.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
