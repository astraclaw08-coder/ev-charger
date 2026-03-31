-- AlterTable: make Charger.siteId nullable for unassign-from-site support
-- Historical sessions are preserved via Connector -> Session chain (no cascade)

-- Drop the existing foreign key constraint
ALTER TABLE "Charger" DROP CONSTRAINT IF EXISTS "Charger_siteId_fkey";

-- Make siteId nullable
ALTER TABLE "Charger" ALTER COLUMN "siteId" DROP NOT NULL;

-- Re-add foreign key with ON DELETE SET NULL
ALTER TABLE "Charger" ADD CONSTRAINT "Charger_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
