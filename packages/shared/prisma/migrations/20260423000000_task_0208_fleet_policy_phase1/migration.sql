-- TASK-0208 Phase 1: Fleet charging (Hybrid-B) schema scaffold.
-- Additive only — no NOT NULL columns added to existing tables.
-- No runtime behavior change on deploy; FleetPolicy rows start empty and
-- sessionSafety fleet carve-out is gated behind FLEET_GATED_SESSIONS_ENABLED.

-- ── Enums ────────────────────────────────────────────────────────────────
CREATE TYPE "FleetPolicyStatus" AS ENUM ('DRAFT', 'ENABLED', 'DISABLED');

-- ── FleetPolicy table ────────────────────────────────────────────────────
CREATE TABLE "FleetPolicy" (
    "id"                  TEXT NOT NULL,
    "siteId"              TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "status"              "FleetPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "idTagPrefix"         TEXT NOT NULL,
    "maxAmps"             INTEGER NOT NULL DEFAULT 32,
    "ocppStackLevel"      INTEGER NOT NULL DEFAULT 90,
    "windowsJson"         JSONB NOT NULL,
    "notes"               TEXT,
    "createdByOperatorId" TEXT,
    "updatedByOperatorId" TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FleetPolicy_siteId_idTagPrefix_key" ON "FleetPolicy"("siteId", "idTagPrefix");
CREATE INDEX "FleetPolicy_siteId_status_idx" ON "FleetPolicy"("siteId", "status");
CREATE INDEX "FleetPolicy_status_idx" ON "FleetPolicy"("status");

ALTER TABLE "FleetPolicy" ADD CONSTRAINT "FleetPolicy_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Session additive fields (Hybrid-B gating timeline) ───────────────────
ALTER TABLE "Session" ADD COLUMN "plugInAt"      TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "firstEnergyAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "lastEnergyAt"  TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "fleetPolicyId" TEXT;

-- No FK on fleetPolicyId: we intentionally keep the session's snapshot of
-- the matched policy even if the policy row is later deleted. (Receipts are
-- immutable history.)

-- ── SessionBillingSnapshot additive fields ───────────────────────────────
ALTER TABLE "SessionBillingSnapshot" ADD COLUMN "preDeliveryGatedMinutes" DOUBLE PRECISION;
ALTER TABLE "SessionBillingSnapshot" ADD COLUMN "gatedPricingMode"        TEXT;
