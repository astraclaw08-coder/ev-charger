-- CreateTable
CREATE TABLE "InAppNotificationCampaign" (
    "id" TEXT NOT NULL,
    "createdByOperatorId" TEXT NOT NULL,
    "targetMode" TEXT NOT NULL,
    "targetUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionLabel" TEXT,
    "actionUrl" TEXT,
    "deepLink" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InAppNotificationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InAppNotificationDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InAppNotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InAppNotificationCampaign_createdByOperatorId_sentAt_idx" ON "InAppNotificationCampaign"("createdByOperatorId", "sentAt");

-- CreateIndex
CREATE INDEX "InAppNotificationCampaign_sentAt_idx" ON "InAppNotificationCampaign"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "InAppNotificationDelivery_campaignId_userId_key" ON "InAppNotificationDelivery"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "InAppNotificationDelivery_userId_createdAt_idx" ON "InAppNotificationDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "InAppNotificationDelivery_campaignId_createdAt_idx" ON "InAppNotificationDelivery"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "InAppNotificationDelivery" ADD CONSTRAINT "InAppNotificationDelivery_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "InAppNotificationCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InAppNotificationDelivery" ADD CONSTRAINT "InAppNotificationDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
