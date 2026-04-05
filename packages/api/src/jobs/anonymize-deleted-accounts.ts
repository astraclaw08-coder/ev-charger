import { prisma } from '@ev-charger/shared';

async function main() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const users = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { lte: cutoff },
    },
    select: {
      id: true,
      email: true,
    },
  });

  for (const user of users) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name: null,
        email: `deleted+${user.id}@redacted.local`,
        phone: null,
        homeAddress: null,
        homeSiteAddress: null,
        homeCity: null,
        homeState: null,
        homeZipCode: null,
        paymentProfile: null,
      },
    });
  }

  console.log(`Anonymized ${users.length} deleted account(s)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
