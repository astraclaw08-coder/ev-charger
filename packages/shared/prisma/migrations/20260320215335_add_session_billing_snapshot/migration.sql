-- CreateTable
CREATE TABLE "SessionBillingSnapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "pricingMode" TEXT NOT NULL,
    "pricePerKwhUsd" DOUBLE PRECISION NOT NULL,
    "idleFeePerMinUsd" DOUBLE PRECISION NOT NULL,
    "activationFeeUsd" DOUBLE PRECISION NOT NULL,
    "gracePeriodMin" INTEGER NOT NULL,
    "touWindowsJson" JSONB,
    "siteTimeZone" TEXT,
    "kwhDelivered" DOUBLE PRECISION,
    "durationMinutes" DOUBLE PRECISION,
    "energyAmountUsd" DOUBLE PRECISION,
    "idleAmountUsd" DOUBLE PRECISION,
    "activationAmountUsd" DOUBLE PRECISION,
    "grossAmountUsd" DOUBLE PRECISION,
    "vendorFeeUsd" DOUBLE PRECISION,
    "netAmountUsd" DOUBLE PRECISION,
    "billingBreakdownJson" JSONB,
    "chargingStartedAt" TIMESTAMP(3),
    "chargingStoppedAt" TIMESTAMP(3),
    "idleStartedAt" TIMESTAMP(3),
    "idleStoppedAt" TIMESTAMP(3),
    "plugOutAt" TIMESTAMP(3),
    "snapshotVersion" TEXT NOT NULL DEFAULT 'v1',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionBillingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionBillingSnapshot_sessionId_key" ON "SessionBillingSnapshot"("sessionId");

-- CreateIndex
CREATE INDEX "SessionBillingSnapshot_sessionId_idx" ON "SessionBillingSnapshot"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionBillingSnapshot" ADD CONSTRAINT "SessionBillingSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
