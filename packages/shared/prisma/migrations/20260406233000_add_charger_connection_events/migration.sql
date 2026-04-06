-- CreateTable
CREATE TABLE "ChargerConnectionEvent" (
  "id" TEXT NOT NULL,
  "chargerId" TEXT NOT NULL,
  "ocppId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "sessionId" TEXT,
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "closeCode" INTEGER,
  "closeReason" TEXT,
  "remoteAddress" TEXT,
  "host" TEXT,
  "path" TEXT,
  "userAgent" TEXT,
  "transportMeta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ChargerConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ChargerConnectionEvent"
ADD CONSTRAINT "ChargerConnectionEvent_chargerId_fkey"
FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ChargerConnectionEvent_chargerId_createdAt_idx" ON "ChargerConnectionEvent"("chargerId", "createdAt");
CREATE INDEX "ChargerConnectionEvent_ocppId_createdAt_idx" ON "ChargerConnectionEvent"("ocppId", "createdAt");
CREATE INDEX "ChargerConnectionEvent_event_createdAt_idx" ON "ChargerConnectionEvent"("event", "createdAt");
CREATE INDEX "ChargerConnectionEvent_sessionId_idx" ON "ChargerConnectionEvent"("sessionId");
