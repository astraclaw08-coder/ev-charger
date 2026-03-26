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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UptimeDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UptimeDaily_chargerId_date_key" ON "UptimeDaily"("chargerId", "date");

-- CreateIndex
CREATE INDEX "UptimeDaily_chargerId_idx" ON "UptimeDaily"("chargerId");

-- CreateIndex
CREATE INDEX "UptimeDaily_date_idx" ON "UptimeDaily"("date");

-- AddForeignKey
ALTER TABLE "UptimeDaily" ADD CONSTRAINT "UptimeDaily_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
