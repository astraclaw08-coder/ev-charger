-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN     "organizationDefaultSite" TEXT,
ADD COLUMN     "organizationPortfolio" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "organizationName" TEXT,
ADD COLUMN     "portfolioName" TEXT;
