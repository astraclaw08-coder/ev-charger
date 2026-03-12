-- TASK-0109 Smart Charging domain + persistence

CREATE TYPE "SmartChargingScope" AS ENUM ('CHARGER', 'GROUP', 'SITE');

CREATE TABLE "ChargerGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "siteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargerGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Charger" ADD COLUMN "groupId" TEXT;

CREATE TABLE "SmartChargingProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "SmartChargingScope" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "defaultLimitKw" DOUBLE PRECISION,
    "schedule" JSONB,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "siteId" TEXT,
    "chargerGroupId" TEXT,
    "chargerId" TEXT,
    "createdByOperatorId" TEXT,
    "updatedByOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmartChargingProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SmartChargingState" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "effectiveLimitKw" DOUBLE PRECISION NOT NULL,
    "fallbackApplied" BOOLEAN NOT NULL DEFAULT false,
    "sourceScope" "SmartChargingScope",
    "sourceProfileId" TEXT,
    "sourceWindowId" TEXT,
    "sourceReason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastAppliedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmartChargingState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmartChargingState_chargerId_key" ON "SmartChargingState"("chargerId");
CREATE INDEX "Charger_groupId_idx" ON "Charger"("groupId");
CREATE INDEX "ChargerGroup_siteId_idx" ON "ChargerGroup"("siteId");
CREATE INDEX "ChargerGroup_name_idx" ON "ChargerGroup"("name");
CREATE INDEX "SmartChargingProfile_scope_enabled_priority_idx" ON "SmartChargingProfile"("scope", "enabled", "priority");
CREATE INDEX "SmartChargingProfile_siteId_scope_enabled_idx" ON "SmartChargingProfile"("siteId", "scope", "enabled");
CREATE INDEX "SmartChargingProfile_chargerGroupId_scope_enabled_idx" ON "SmartChargingProfile"("chargerGroupId", "scope", "enabled");
CREATE INDEX "SmartChargingProfile_chargerId_scope_enabled_idx" ON "SmartChargingProfile"("chargerId", "scope", "enabled");
CREATE INDEX "SmartChargingState_status_updatedAt_idx" ON "SmartChargingState"("status", "updatedAt");
CREATE INDEX "SmartChargingState_sourceProfileId_idx" ON "SmartChargingState"("sourceProfileId");

ALTER TABLE "Charger" ADD CONSTRAINT "Charger_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ChargerGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ChargerGroup" ADD CONSTRAINT "ChargerGroup_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmartChargingProfile" ADD CONSTRAINT "SmartChargingProfile_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartChargingProfile" ADD CONSTRAINT "SmartChargingProfile_chargerGroupId_fkey" FOREIGN KEY ("chargerGroupId") REFERENCES "ChargerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartChargingProfile" ADD CONSTRAINT "SmartChargingProfile_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartChargingState" ADD CONSTRAINT "SmartChargingState_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmartChargingState" ADD CONSTRAINT "SmartChargingState_sourceProfileId_fkey" FOREIGN KEY ("sourceProfileId") REFERENCES "SmartChargingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmartChargingProfile"
  ADD CONSTRAINT "SmartChargingProfile_scope_target_check"
  CHECK (
    ("scope" = 'CHARGER' AND "chargerId" IS NOT NULL AND "chargerGroupId" IS NULL AND "siteId" IS NULL)
    OR ("scope" = 'GROUP' AND "chargerGroupId" IS NOT NULL AND "chargerId" IS NULL AND "siteId" IS NULL)
    OR ("scope" = 'SITE' AND "siteId" IS NOT NULL AND "chargerId" IS NULL AND "chargerGroupId" IS NULL)
  );
