-- CreateEnum
CREATE TYPE "OcppOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "OcppEventOutbox" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "direction" "OcppDirection" NOT NULL DEFAULT 'INBOUND',
    "payload" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "OcppOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OcppEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OcppEventOutbox_idempotencyKey_key" ON "OcppEventOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OcppEventOutbox_status_nextAttemptAt_idx" ON "OcppEventOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OcppEventOutbox_chargerId_createdAt_idx" ON "OcppEventOutbox"("chargerId", "createdAt");

-- CreateIndex
CREATE INDEX "OcppEventOutbox_eventType_createdAt_idx" ON "OcppEventOutbox"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "OcppEventOutbox" ADD CONSTRAINT "OcppEventOutbox_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
