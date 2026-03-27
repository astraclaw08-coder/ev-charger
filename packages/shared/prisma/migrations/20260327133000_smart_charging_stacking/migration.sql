-- Smart Charging Stacking: allow multiple state rows per charger (one per profile)

-- Drop the old unique constraint on chargerId
ALTER TABLE "SmartChargingState" DROP CONSTRAINT IF EXISTS "SmartChargingState_chargerId_key";

-- Add new columns for OCPP stacking
ALTER TABLE "SmartChargingState" ADD COLUMN "ocppChargingProfileId" INTEGER;
ALTER TABLE "SmartChargingState" ADD COLUMN "ocppStackLevel" INTEGER;
ALTER TABLE "SmartChargingState" ADD COLUMN "compositeScheduleVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SmartChargingState" ADD COLUMN "compositeScheduleVerifiedAt" TIMESTAMP(3);

-- Add stack level base to profiles (SITE=10, GROUP=30, CHARGER=50)
ALTER TABLE "SmartChargingProfile" ADD COLUMN "ocppStackLevelBase" INTEGER NOT NULL DEFAULT 50;

-- Composite unique: one state row per (charger, profile)
CREATE UNIQUE INDEX "SmartChargingState_chargerId_sourceProfileId_key" ON "SmartChargingState"("chargerId", "sourceProfileId");

-- Index for fast charger lookups (no longer unique)
CREATE INDEX "SmartChargingState_chargerId_idx" ON "SmartChargingState"("chargerId");
