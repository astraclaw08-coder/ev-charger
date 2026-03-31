-- CreateTable: ChargerHealthAssessment for persisting diagnostic reports
CREATE TABLE "ChargerHealthAssessment" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "connectorId" INTEGER,
    "overallScore" INTEGER NOT NULL,
    "overallStatus" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargerHealthAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargerHealthAssessment_chargerId_createdAt_idx" ON "ChargerHealthAssessment"("chargerId", "createdAt");

-- AddForeignKey
ALTER TABLE "ChargerHealthAssessment" ADD CONSTRAINT "ChargerHealthAssessment_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
