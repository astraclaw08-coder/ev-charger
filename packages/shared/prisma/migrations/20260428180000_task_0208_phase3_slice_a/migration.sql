-- TASK-0208 Phase 3 Slice A — Fleet-Auto activation foundation.
--
-- Additive only. All new columns have safe defaults that preserve current
-- behavior. No runtime fleet code consumes these fields yet — Slice C
-- wires `fleetAutoStart.ts` once this schema is live in all environments.
--
-- Two-tier rollout control:
--   - FLEET_GATED_SESSIONS_ENABLED env var stays as the emergency global
--     kill switch (restart-cost acceptable, incident-only).
--   - Site.fleetAutoRolloutEnabled + Connector.fleetAutoRolloutEnabled are
--     DB-backed pilot flags toggled via the operator portal (Slice B).
--     No restart per flip; cache TTL ≤30 s on the runtime side.
--
-- Idempotency:
--   - Every column add uses ADD COLUMN IF NOT EXISTS.
--   - Enum creation is wrapped in a DO block that swallows duplicate_object.
--   - Index creation uses CREATE INDEX IF NOT EXISTS.
--   - The autoStartIdTag backfill is filter-guarded (WHERE ... IS NULL) so a
--     re-run is a no-op.
-- See tasks/task-0208-phase3-fleet-auto-redesign.md for design context.

-- ── Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ChargingMode" AS ENUM ('PUBLIC', 'FLEET_AUTO');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ── Site: pilot rollout flag (DB-backed, no restart to flip) ─────────────
ALTER TABLE "Site"
  ADD COLUMN IF NOT EXISTS "fleetAutoRolloutEnabled" BOOLEAN NOT NULL DEFAULT false;

-- ── Connector: chargingMode + direct FleetPolicy FK + per-connector override
ALTER TABLE "Connector"
  ADD COLUMN IF NOT EXISTS "chargingMode" "ChargingMode" NOT NULL DEFAULT 'PUBLIC';
ALTER TABLE "Connector"
  ADD COLUMN IF NOT EXISTS "fleetPolicyId" TEXT;
-- null = inherit Site.fleetAutoRolloutEnabled; explicit boolean overrides it.
ALTER TABLE "Connector"
  ADD COLUMN IF NOT EXISTS "fleetAutoRolloutEnabled" BOOLEAN;

CREATE INDEX IF NOT EXISTS "Connector_chargingMode_idx" ON "Connector"("chargingMode");
CREATE INDEX IF NOT EXISTS "Connector_fleetPolicyId_idx" ON "Connector"("fleetPolicyId");

-- FK with ON DELETE SET NULL: deleting a FleetPolicy detaches connectors
-- but does not cascade-delete them (chargers/connectors are physical, policies
-- are policy config). Drop-then-add pattern keeps re-runs clean.
ALTER TABLE "Connector" DROP CONSTRAINT IF EXISTS "Connector_fleetPolicyId_fkey";
ALTER TABLE "Connector"
  ADD CONSTRAINT "Connector_fleetPolicyId_fkey"
  FOREIGN KEY ("fleetPolicyId") REFERENCES "FleetPolicy"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── FleetPolicy: alwaysOn + autoStartIdTag ───────────────────────────────
ALTER TABLE "FleetPolicy"
  ADD COLUMN IF NOT EXISTS "alwaysOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "FleetPolicy"
  ADD COLUMN IF NOT EXISTS "autoStartIdTag" TEXT;

-- Backfill autoStartIdTag for existing Hybrid-B rows so Slice C can rely on
-- a non-null value at runtime. Use the legacy idTagPrefix as the deterministic
-- base when present and non-empty; otherwise generate from the policy id.
-- Filter ensures idempotency on re-run.
UPDATE "FleetPolicy"
SET "autoStartIdTag" =
  CASE
    WHEN "idTagPrefix" IS NOT NULL AND length(trim("idTagPrefix")) > 0
      THEN "idTagPrefix"
    ELSE 'FLEET-AUTO-' || substr("id", 1, 8)
  END
WHERE "autoStartIdTag" IS NULL;

-- Note: column intentionally stays nullable in the DB for this slice.
-- Application-layer Zod validators (packages/shared/src/fleetPolicy.ts)
-- enforce required-on-write for new/edited policies; API surface lands in
-- Slice B. A future migration may ALTER ... SET NOT NULL once all
-- environments confirm the column is fully populated.

-- ── Site-scoped uniqueness on autoStartIdTag (advisory) ──────────────────
-- Postgres supports partial unique indexes; we restrict to non-null tags so
-- legacy rows that never got backfilled (shouldn't happen, but defensive)
-- don't block the index. ENABLED + DRAFT scoping is enforced at API layer
-- because Prisma can't model partial-by-status indexes portably.
CREATE UNIQUE INDEX IF NOT EXISTS "FleetPolicy_siteId_autoStartIdTag_key"
  ON "FleetPolicy"("siteId", "autoStartIdTag")
  WHERE "autoStartIdTag" IS NOT NULL;
