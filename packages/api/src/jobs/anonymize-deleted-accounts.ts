import { prisma } from '@ev-charger/shared';

async function main() {
  // No-op until deletion tracking fields exist in the Prisma schema.
  console.log('Anonymize deleted accounts skipped: deletion tracking is not available in current schema.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
