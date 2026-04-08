-- CreateTable: Organization
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingAddress" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Portfolio
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "description" TEXT,
    "isGlobal" BOOLEAN NOT NULL DEFAULT false,
    "createdByOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Site — add organizationId and portfolioId FK columns
ALTER TABLE "Site" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Site" ADD COLUMN "portfolioId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_name_key" ON "Organization"("name");
CREATE UNIQUE INDEX "Portfolio_name_organizationId_key" ON "Portfolio"("name", "organizationId");
CREATE INDEX "Portfolio_organizationId_idx" ON "Portfolio"("organizationId");
CREATE INDEX "Site_organizationId_idx" ON "Site"("organizationId");
CREATE INDEX "Site_portfolioId_idx" ON "Site"("portfolioId");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Site" ADD CONSTRAINT "Site_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data migration: backfill Organization rows from existing Site.organizationName values
INSERT INTO "Organization" ("id", "name", "createdByOperatorId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), sub."organizationName", 'migration', NOW(), NOW()
FROM (SELECT DISTINCT "organizationName" FROM "Site" WHERE "organizationName" IS NOT NULL AND "organizationName" != '') sub
ON CONFLICT ("name") DO NOTHING;

-- Data migration: backfill Portfolio rows scoped to organizations
INSERT INTO "Portfolio" ("id", "name", "organizationId", "description", "isGlobal", "createdByOperatorId", "createdAt", "updatedAt")
SELECT gen_random_uuid(), sub."portfolioName", o."id", NULL, false, 'migration', NOW(), NOW()
FROM (
  SELECT DISTINCT "organizationName", "portfolioName"
  FROM "Site"
  WHERE "portfolioName" IS NOT NULL AND "portfolioName" != ''
    AND "organizationName" IS NOT NULL AND "organizationName" != ''
) sub
JOIN "Organization" o ON o."name" = sub."organizationName"
ON CONFLICT ("name", "organizationId") DO NOTHING;

-- Data migration: backfill Site.organizationId from Organization.name
UPDATE "Site" s SET "organizationId" = o."id"
FROM "Organization" o
WHERE o."name" = s."organizationName" AND s."organizationName" IS NOT NULL;

-- Data migration: backfill Site.portfolioId from Portfolio
UPDATE "Site" s SET "portfolioId" = p."id"
FROM "Portfolio" p
JOIN "Organization" o ON p."organizationId" = o."id"
WHERE o."name" = s."organizationName" AND p."name" = s."portfolioName"
  AND s."portfolioName" IS NOT NULL AND s."organizationName" IS NOT NULL;
