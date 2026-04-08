-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN     "openaiAccessToken" TEXT,
ADD COLUMN     "openaiRefreshToken" TEXT,
ADD COLUMN     "openaiTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "openaiConnectedEmail" TEXT,
ADD COLUMN     "openaiConnectedAt" TIMESTAMP(3);
