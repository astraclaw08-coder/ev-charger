/*
  Warnings:

  - You are about to drop the `AuthOtpChallenge` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `AuthSession` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "AuthSession" DROP CONSTRAINT "AuthSession_userId_fkey";

-- AlterTable
ALTER TABLE "InAppNotificationCampaign" ALTER COLUMN "targetUserIds" DROP DEFAULT,
ALTER COLUMN "targetEmails" DROP DEFAULT;

-- DropTable
DROP TABLE "AuthOtpChallenge";

-- DropTable
DROP TABLE "AuthSession";

-- DropEnum
DROP TYPE "OtpChannel";

-- CreateTable
CREATE TABLE "ConnectorStateTransition" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "connectorRefId" TEXT NOT NULL,
    "connectorId" INTEGER NOT NULL,
    "fromStatus" "ConnectorStatus" NOT NULL,
    "toStatus" "ConnectorStatus" NOT NULL,
    "transitionType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payloadTs" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorStateTransition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectorStateTransition_chargerId_connectorId_occurredAt_idx" ON "ConnectorStateTransition"("chargerId", "connectorId", "occurredAt");

-- CreateIndex
CREATE INDEX "ConnectorStateTransition_transitionType_occurredAt_idx" ON "ConnectorStateTransition"("transitionType", "occurredAt");

-- AddForeignKey
ALTER TABLE "ConnectorStateTransition" ADD CONSTRAINT "ConnectorStateTransition_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorStateTransition" ADD CONSTRAINT "ConnectorStateTransition_connectorRefId_fkey" FOREIGN KEY ("connectorRefId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;
