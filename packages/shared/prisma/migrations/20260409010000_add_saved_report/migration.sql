-- CreateTable
CREATE TABLE "SavedReport" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "reportType" TEXT NOT NULL DEFAULT 'interval_usage',
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SavedReport_operatorId_name_key" ON "SavedReport"("operatorId", "name");

-- CreateIndex
CREATE INDEX "SavedReport_operatorId_reportType_idx" ON "SavedReport"("operatorId", "reportType");
