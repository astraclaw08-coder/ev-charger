-- CreateTable
CREATE TABLE "PortalSettings" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "organizationName" TEXT,
    "organizationBillingAddress" TEXT,
    "supportContactEmail" TEXT,
    "supportContactPhone" TEXT,
    "profileDisplayName" TEXT,
    "profileTimezone" TEXT,
    "remittanceBankName" TEXT,
    "remittanceAccountType" TEXT,
    "remittanceEmail" TEXT,
    "routingNumber" TEXT,
    "accountNumber" TEXT,
    "updatedByOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatorNotificationPreference" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outageAlerts" BOOLEAN NOT NULL DEFAULT true,
    "billingAlerts" BOOLEAN NOT NULL DEFAULT true,
    "weeklyDigest" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargerModelCatalog" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "modelCode" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "maxKw" DOUBLE PRECISION NOT NULL,
    "connectorType" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedByOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargerModelCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalSettings_scopeKey_key" ON "PortalSettings"("scopeKey");

-- CreateIndex
CREATE INDEX "PortalSettings_scopeKey_idx" ON "PortalSettings"("scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorNotificationPreference_operatorId_key" ON "OperatorNotificationPreference"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "ChargerModelCatalog_scopeKey_modelCode_key" ON "ChargerModelCatalog"("scopeKey", "modelCode");

-- CreateIndex
CREATE INDEX "ChargerModelCatalog_scopeKey_isActive_idx" ON "ChargerModelCatalog"("scopeKey", "isActive");
