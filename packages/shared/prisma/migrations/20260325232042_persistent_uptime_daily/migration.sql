-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UptimeEventType" ADD VALUE 'SCHEDULED_MAINTENANCE';
ALTER TYPE "UptimeEventType" ADD VALUE 'UTILITY_INTERRUPTION';
ALTER TYPE "UptimeEventType" ADD VALUE 'VEHICLE_FAULT';
ALTER TYPE "UptimeEventType" ADD VALUE 'VANDALISM';
ALTER TYPE "UptimeEventType" ADD VALUE 'FORCE_MAJEURE';

-- CreateTable
CREATE TABLE "UptimeDaily" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalSeconds" INTEGER NOT NULL,
    "availableSeconds" INTEGER NOT NULL,
    "outageSeconds" INTEGER NOT NULL,
    "excludedOutageSeconds" INTEGER NOT NULL DEFAULT 0,
    "uptimePercent" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UptimeDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UptimeDaily_chargerId_idx" ON "UptimeDaily"("chargerId");

-- CreateIndex
CREATE INDEX "UptimeDaily_date_idx" ON "UptimeDaily"("date");

-- CreateIndex
CREATE UNIQUE INDEX "UptimeDaily_chargerId_date_key" ON "UptimeDaily"("chargerId", "date");

-- AddForeignKey
ALTER TABLE "UptimeDaily" ADD CONSTRAINT "UptimeDaily_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
