-- CreateTable
CREATE TABLE "SessionFact" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "organizationName" TEXT,
    "portfolioName" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "energyKwh" DECIMAL(18,6),
    "revenueUsd" DECIMAL(18,6),
    "status" "SessionStatus" NOT NULL,
    "sourceVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RebateInterval15m" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "connectorId" INTEGER NOT NULL,
    "intervalStart" TIMESTAMP(3) NOT NULL,
    "intervalEnd" TIMESTAMP(3) NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "energyKwh" DECIMAL(18,6) NOT NULL,
    "avgPowerKw" DECIMAL(18,6) NOT NULL,
    "maxPowerKw" DECIMAL(18,6),
    "portStatus" TEXT,
    "vehicleConnected" BOOLEAN,
    "dataQualityFlag" TEXT,
    "sourceVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RebateInterval15m_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteDailyFact" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "sessionsCount" INTEGER NOT NULL DEFAULT 0,
    "totalEnergyKwh" DECIMAL(18,6) NOT NULL,
    "totalRevenueUsd" DECIMAL(18,6),
    "avgPowerKw" DECIMAL(18,6),
    "sourceVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDailyFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionFact_sessionId_key" ON "SessionFact"("sessionId");

-- CreateIndex
CREATE INDEX "SessionFact_siteId_startedAt_idx" ON "SessionFact"("siteId", "startedAt");

-- CreateIndex
CREATE INDEX "SessionFact_chargerId_startedAt_idx" ON "SessionFact"("chargerId", "startedAt");

-- CreateIndex
CREATE INDEX "SessionFact_organizationName_startedAt_idx" ON "SessionFact"("organizationName", "startedAt");

-- CreateIndex
CREATE INDEX "SessionFact_portfolioName_startedAt_idx" ON "SessionFact"("portfolioName", "startedAt");

-- CreateIndex
CREATE INDEX "RebateInterval15m_siteId_intervalStart_idx" ON "RebateInterval15m"("siteId", "intervalStart");

-- CreateIndex
CREATE INDEX "RebateInterval15m_sessionId_intervalStart_idx" ON "RebateInterval15m"("sessionId", "intervalStart");

-- CreateIndex
CREATE UNIQUE INDEX "RebateInterval15m_chargerId_connectorId_intervalStart_inter_key" ON "RebateInterval15m"("chargerId", "connectorId", "intervalStart", "intervalEnd", "sourceVersion");

-- CreateIndex
CREATE INDEX "SiteDailyFact_day_idx" ON "SiteDailyFact"("day");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDailyFact_siteId_day_sourceVersion_key" ON "SiteDailyFact"("siteId", "day", "sourceVersion");

-- AddForeignKey
ALTER TABLE "SessionFact" ADD CONSTRAINT "SessionFact_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionFact" ADD CONSTRAINT "SessionFact_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionFact" ADD CONSTRAINT "SessionFact_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RebateInterval15m" ADD CONSTRAINT "RebateInterval15m_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RebateInterval15m" ADD CONSTRAINT "RebateInterval15m_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RebateInterval15m" ADD CONSTRAINT "RebateInterval15m_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDailyFact" ADD CONSTRAINT "SiteDailyFact_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
