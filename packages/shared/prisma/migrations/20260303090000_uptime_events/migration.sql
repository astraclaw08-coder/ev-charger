-- Add DEGRADED status for charger heartbeat/liveness monitoring
ALTER TYPE "ChargerStatus" ADD VALUE IF NOT EXISTS 'DEGRADED';

-- Uptime event classification
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UptimeEventType') THEN
    CREATE TYPE "UptimeEventType" AS ENUM ('ONLINE', 'OFFLINE', 'FAULTED', 'DEGRADED', 'RECOVERED');
  END IF;
END$$;

-- Event stream for uptime incidents and transitions
CREATE TABLE IF NOT EXISTS "UptimeEvent" (
  "id" TEXT PRIMARY KEY,
  "chargerId" TEXT NOT NULL,
  "connectorId" INTEGER,
  "event" "UptimeEventType" NOT NULL,
  "reason" TEXT,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UptimeEvent_chargerId_fkey" FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "UptimeEvent_chargerId_createdAt_idx" ON "UptimeEvent"("chargerId", "createdAt");
CREATE INDEX IF NOT EXISTS "UptimeEvent_createdAt_idx" ON "UptimeEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "UptimeEvent_event_idx" ON "UptimeEvent"("event");
