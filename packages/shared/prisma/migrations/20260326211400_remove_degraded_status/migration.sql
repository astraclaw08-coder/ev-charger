-- Migrate existing DEGRADED chargers to OFFLINE
UPDATE "Charger" SET status = 'OFFLINE' WHERE status = 'DEGRADED';

-- Migrate existing DEGRADED uptime events to OFFLINE
UPDATE "UptimeEvent" SET event = 'OFFLINE' WHERE event = 'DEGRADED';

-- Remove DEGRADED from ChargerStatus enum
-- Drop default first, then alter type, then restore default
ALTER TABLE "Charger" ALTER COLUMN status DROP DEFAULT;
ALTER TYPE "ChargerStatus" RENAME TO "ChargerStatus_old";
CREATE TYPE "ChargerStatus" AS ENUM ('OFFLINE', 'ONLINE', 'FAULTED');
ALTER TABLE "Charger" ALTER COLUMN status TYPE "ChargerStatus" USING status::text::"ChargerStatus";
ALTER TABLE "Charger" ALTER COLUMN status SET DEFAULT 'OFFLINE'::"ChargerStatus";
DROP TYPE "ChargerStatus_old";

-- Remove DEGRADED from UptimeEventType enum, add NEVI excluded outage types
ALTER TYPE "UptimeEventType" RENAME TO "UptimeEventType_old";
CREATE TYPE "UptimeEventType" AS ENUM ('ONLINE', 'OFFLINE', 'FAULTED', 'RECOVERED', 'SCHEDULED_MAINTENANCE', 'UTILITY_INTERRUPTION', 'VEHICLE_FAULT', 'VANDALISM', 'FORCE_MAJEURE');
ALTER TABLE "UptimeEvent" ALTER COLUMN event TYPE "UptimeEventType" USING event::text::"UptimeEventType";
DROP TYPE "UptimeEventType_old";
