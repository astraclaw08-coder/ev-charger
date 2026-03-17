import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const charger1A32 = await prisma.charger.findFirst({
    where: { ocppId: '1A32-1-2010-00008' },
    select: { id: true, ocppId: true, siteId: true }
  });
  const chargerW1 = await prisma.charger.findFirst({
    where: { ocppId: 'W1-1962-3LOG-1-2235-00101' },
    select: { id: true, ocppId: true, siteId: true }
  });

  console.log('1A32:', JSON.stringify(charger1A32));
  console.log('W1:', JSON.stringify(chargerW1));

  const schedule = [
    { id: 'daily-10-12', daysOfWeek: [0,1,2,3,4,5,6], startTime: '10:00', endTime: '12:00', limitKw: 6 }
  ];

  const db: any = prisma;
  for (const charger of [charger1A32, chargerW1].filter(Boolean)) {
    const existing = await db.smartChargingProfile.findFirst({
      where: { chargerId: charger!.id, name: 'Daily 10-12 6kW cap' }
    });
    if (existing) {
      console.log(`SKIP ${charger!.ocppId}: profile exists id=${existing.id}`);
      continue;
    }
    const profile = await db.smartChargingProfile.create({
      data: {
        name: 'Daily 10-12 6kW cap',
        scope: 'CHARGER',
        chargerId: charger!.id,
        siteId: null,
        chargerGroupId: null,
        defaultLimitKw: null,
        priority: 100,
        enabled: true,
        schedule,
        validFrom: null,
        validTo: null,
      }
    });
    console.log(`CREATED profile for ${charger!.ocppId}: id=${profile.id}`);
  }
}

main()
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
