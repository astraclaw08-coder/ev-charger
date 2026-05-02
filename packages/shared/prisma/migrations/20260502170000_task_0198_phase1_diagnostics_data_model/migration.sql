-- CreateTable
CREATE TABLE "ChargerEvent" (
    "id" TEXT NOT NULL,
    "chargerId" TEXT NOT NULL,
    "connectorId" INTEGER,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "errorCode" TEXT,
    "vendorErrorCode" TEXT,
    "vendorId" TEXT,
    "payloadSummary" JSONB NOT NULL,
    "sourceOcppLogId" TEXT,
    "detectedBy" TEXT NOT NULL DEFAULT 'live',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChargerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagKnowledgeDoc" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'repo',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagKnowledgeDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagConversation" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "orgId" TEXT,
    "siteId" TEXT,
    "chargerId" TEXT,
    "title" TEXT NOT NULL,
    "modelProvider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "toolCallsJson" JSONB,
    "toolName" TEXT,
    "toolResultJson" JSONB,
    "modelProvider" TEXT,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "citedEvidenceJson" JSONB,
    "redactionsAppliedJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteHealthReport" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "windowStartAt" TIMESTAMP(3) NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "summaryJson" JSONB NOT NULL,
    "markdown" TEXT NOT NULL,
    "modelProvider" TEXT,
    "model" TEXT,
    "deliveredAtJson" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteHealthReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChargerEvent_chargerId_detectedAt_idx" ON "ChargerEvent"("chargerId", "detectedAt");

-- CreateIndex
CREATE INDEX "ChargerEvent_kind_detectedAt_idx" ON "ChargerEvent"("kind", "detectedAt");

-- CreateIndex
CREATE INDEX "ChargerEvent_severity_detectedAt_idx" ON "ChargerEvent"("severity", "detectedAt");

-- CreateIndex
CREATE INDEX "ChargerEvent_sourceOcppLogId_idx" ON "ChargerEvent"("sourceOcppLogId");

-- CreateIndex
CREATE INDEX "DiagKnowledgeDoc_slug_idx" ON "DiagKnowledgeDoc"("slug");

-- CreateIndex
CREATE INDEX "DiagKnowledgeDoc_supersededAt_idx" ON "DiagKnowledgeDoc"("supersededAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiagKnowledgeDoc_slug_version_key" ON "DiagKnowledgeDoc"("slug", "version");

-- CreateIndex
CREATE INDEX "DiagConversation_operatorId_createdAt_idx" ON "DiagConversation"("operatorId", "createdAt");

-- CreateIndex
CREATE INDEX "DiagConversation_orgId_createdAt_idx" ON "DiagConversation"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "DiagConversation_siteId_createdAt_idx" ON "DiagConversation"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "DiagConversation_chargerId_createdAt_idx" ON "DiagConversation"("chargerId", "createdAt");

-- CreateIndex
CREATE INDEX "DiagMessage_conversationId_createdAt_idx" ON "DiagMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteHealthReport_siteId_generatedAt_idx" ON "SiteHealthReport"("siteId", "generatedAt");

-- CreateIndex
CREATE INDEX "SiteHealthReport_windowStartAt_windowEndAt_idx" ON "SiteHealthReport"("windowStartAt", "windowEndAt");

-- AddForeignKey
ALTER TABLE "ChargerEvent" ADD CONSTRAINT "ChargerEvent_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagConversation" ADD CONSTRAINT "DiagConversation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagConversation" ADD CONSTRAINT "DiagConversation_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagMessage" ADD CONSTRAINT "DiagMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DiagConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteHealthReport" ADD CONSTRAINT "SiteHealthReport_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

