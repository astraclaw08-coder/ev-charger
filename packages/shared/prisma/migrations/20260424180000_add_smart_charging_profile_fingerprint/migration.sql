-- Repair migration for schema drift introduced by commit f0c569b
-- ("fix(smart-charging): fix false-equivalent skip that prevented profile push to charger", Apr 16 2026).
-- That commit added profileFingerprint to schema.prisma and runtime code, but
-- shipped no migration. This repair makes `prisma migrate diff` clean on fresh
-- environments and keeps `prisma migrate deploy` idempotent in environments
-- where the column was already created out-of-band.

-- Additive, idempotent.
ALTER TABLE "SmartChargingState" ADD COLUMN IF NOT EXISTS "profileFingerprint" TEXT;
