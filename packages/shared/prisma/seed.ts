import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

function generateIdTag(): string {
  return randomBytes(8).toString('hex').toUpperCase().slice(0, 20);
}

async function main() {
  console.log('🌱 Seeding database...');

  // ─── Sites ────────────────────────────────────────────────────────────────

  const site1 = await prisma.site.upsert({
    where: { id: 'site-hawthorne-001' },
    update: {},
    create: {
      id: 'site-hawthorne-001',
      name: 'Hawthorne Supercharger Hub',
      address: '11111 Hawthorne Blvd, Hawthorne, CA 90250',
      lat: 33.9164,
      lng: -118.3526,
      operatorId: 'operator-001',
    },
  });

  const site2 = await prisma.site.upsert({
    where: { id: 'site-manhattan-001' },
    update: {},
    create: {
      id: 'site-manhattan-001',
      name: 'Manhattan Beach Charging Station',
      address: '400 N Sepulveda Blvd, Manhattan Beach, CA 90266',
      lat: 33.8847,
      lng: -118.3967,
      operatorId: 'operator-001',
    },
  });

  console.log(`✅ Created sites: "${site1.name}", "${site2.name}"`);

  // ─── Chargers ─────────────────────────────────────────────────────────────

  const charger1 = await prisma.charger.upsert({
    where: { ocppId: 'CP001' },
    update: {},
    create: {
      id: 'charger-001',
      siteId: site1.id,
      ocppId: 'CP001',
      serialNumber: 'ABB-EVL9-001',
      model: 'Terra 54',
      vendor: 'ABB',
      password: hashPassword('cp001-secret'),
      status: 'ONLINE',
      connectors: {
        create: [
          { connectorId: 1, status: 'AVAILABLE' },
          { connectorId: 2, status: 'AVAILABLE' },
        ],
      },
    },
  });

  const charger2 = await prisma.charger.upsert({
    where: { ocppId: 'CP002' },
    update: {},
    create: {
      id: 'charger-002',
      siteId: site1.id,
      ocppId: 'CP002',
      serialNumber: 'ABB-EVL9-002',
      model: 'Terra 54',
      vendor: 'ABB',
      password: hashPassword('cp002-secret'),
      status: 'ONLINE',
      connectors: {
        create: [
          { connectorId: 1, status: 'AVAILABLE' },
          { connectorId: 2, status: 'FAULTED' },
        ],
      },
    },
  });

  const charger3 = await prisma.charger.upsert({
    where: { ocppId: 'CP003' },
    update: {},
    create: {
      id: 'charger-003',
      siteId: site2.id,
      ocppId: 'CP003',
      serialNumber: 'CHD-QPW7-001',
      model: 'QPW-7000',
      vendor: 'ChargePoint',
      password: hashPassword('cp003-secret'),
      status: 'OFFLINE',
      connectors: {
        create: [{ connectorId: 1, status: 'UNAVAILABLE' }],
      },
    },
  });

  const charger4 = await prisma.charger.upsert({
    where: { ocppId: 'CP004' },
    update: {},
    create: {
      id: 'charger-004',
      siteId: site2.id,
      ocppId: 'CP004',
      serialNumber: 'CHD-QPW7-002',
      model: 'QPW-7000',
      vendor: 'ChargePoint',
      password: hashPassword('cp004-secret'),
      status: 'ONLINE',
      connectors: {
        create: [{ connectorId: 1, status: 'CHARGING' }],
      },
    },
  });

  console.log(`✅ Created chargers: ${[charger1, charger2, charger3, charger4].map(c => c.ocppId).join(', ')}`);

  // ─── Test driver user ─────────────────────────────────────────────────────

  const testIdTag = 'TESTDRIVER0001';
  const driver = await prisma.user.upsert({
    where: { email: 'driver@test.evcharger.dev' },
    update: {},
    create: {
      id: 'user-test-driver-001',
      clerkId: 'clerk_test_driver_001',
      email: 'driver@test.evcharger.dev',
      name: 'Test Driver',
      idTag: testIdTag,
    },
  });

  console.log(`✅ Created test driver: ${driver.email} (idTag: ${driver.idTag})`);

  // ─── Summary ──────────────────────────────────────────────────────────────

  const counts = await Promise.all([
    prisma.site.count(),
    prisma.charger.count(),
    prisma.connector.count(),
    prisma.user.count(),
  ]);

  console.log('\n📊 Database summary:');
  console.log(`  Sites:      ${counts[0]}`);
  console.log(`  Chargers:   ${counts[1]}`);
  console.log(`  Connectors: ${counts[2]}`);
  console.log(`  Users:      ${counts[3]}`);
  console.log('\n✨ Seed complete.');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
