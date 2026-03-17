// Create smart charging profile for 1A32 + W1 via Prisma in prod DB
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find the chargers
  const charger1A32 = await prisma.charger.findFirst({ where: { ocppId: '1A32-1-2010-00008' }, select: { id: true, ocppId: true, siteId: true, status: true } });
  const chargerW1 = await prisma.charger.findFirst({ where: { ocppId: 'W1-1962-3LOG-1-2235-00101' }, select: { id: true, ocppId: true, siteId: true, status: true } });
  
  console.log('1A32 DB record:', charger1A32);
  console.log('W1 DB record:', chargerW1);

  const schedule = [
    { id: 'daily-10-12', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '12:00', limitKw: 6 }
  ];

  const profilesCreated = [];

  for (const charger of [charger1A32, chargerW1].filter(Boolean)) {
    // Check if profile already exists for this charger
    const existing = await prisma.smartChargingProfile.findFirst({
      where: { chargerId: charger.id, name: 'Daily 10-12 6kW cap' }
    });

    if (existing) {
      console.log(`Profile already exists for ${charger.ocppId}: ${existing.id}`);
      profilesCreated.push({ charger: charger.ocppId, profileId: existing.id, action: 'already_exists' });
      continue;
    }

    const profile = await prisma.smartChargingProfile.create({
      data: {
        name: 'Daily 10-12 6kW cap',
        scope: 'CHARGER',
        chargerId: charger.id,
        siteId: null,
        chargerGroupId: null,
        defaultLimitKw: null,
        priority: 100,
        enabled: true,
        schedule: schedule,
        validFrom: null,
        validTo: null,
      }
    });
    console.log(`Created profile for ${charger.ocppId}:`, profile.id);
    profilesCreated.push({ charger: charger.ocppId, profileId: profile.id, action: 'created' });
  }

  console.log('RESULT:', JSON.stringify(profilesCreated));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); }).finally(() => prisma.$disconnect());
