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
-- base ONLY when it is ≤20 chars (OCPP 1.6 RemoteStartTransaction.idTag is
-- CiString20Type — anything longer would be rejected by the charger at
-- runtime). For prefixes longer than 20 chars, or empty/null prefixes, fall
-- back to a deterministic 'FLEET-AUTO-<8-char-policy-id>' (19 chars total).
-- Filter ensures idempotency on re-run.
UPDATE "FleetPolicy"
SET "autoStartIdTag" =
  CASE
    WHEN "idTagPrefix" IS NOT NULL
         AND length(trim("idTagPrefix")) > 0
         AND length(trim("idTagPrefix")) <= 20
      THEN trim("idTagPrefix")
    ELSE 'FLEET-AUTO-' || substr("id", 1, 8)
  END
WHERE "autoStartIdTag" IS NULL;

-- Note: column intentionally stays nullable in the DB for this slice.
-- Application-layer Zod validators (packages/shared/src/fleetPolicy.ts)
-- enforce required-on-write for new/edited policies; API surface lands in
-- Slice B. A future migration may ALTER ... SET NOT NULL once all
-- environments confirm the column is fully populated.

-- ── Site-scoped uniqueness on autoStartIdTag (DRAFT/ENABLED only) ────────
-- Partial unique index restricted to active scopes (DRAFT, ENABLED). The
-- validator (findAutoStartIdTagCollision in packages/shared/src/fleetPolicy.ts)
-- explicitly allows reuse of an autoStartIdTag from a DISABLED sibling — a
-- DB-level uniqueness over ALL non-null rows would contradict that and
-- surprise operators when retiring/repurposing policies. The DB index
-- mirrors the validator: only DRAFT + ENABLED rows participate.
--
-- Drop-then-create is intentional: any environment that applied an earlier
-- iteration of this migration (e.g. a developer's local DB) may already
-- have the over-broad index. DROP IF EXISTS is idempotent for fresh envs
-- and corrective for upgraded ones.
DROP INDEX IF EXISTS "FleetPolicy_siteId_autoStartIdTag_key";
CREATE UNIQUE INDEX IF NOT EXISTS "FleetPolicy_siteId_autoStartIdTag_key"
  ON "FleetPolicy"("siteId", "autoStartIdTag")
  WHERE "autoStartIdTag" IS NOT NULL
    AND "status" IN ('DRAFT', 'ENABLED');
