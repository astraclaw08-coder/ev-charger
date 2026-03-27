-- Drop the stale unique index on chargerId that was left behind when
-- the constraint was dropped. Prisma's DROP CONSTRAINT only removes the
-- constraint object, not the backing unique index.
DROP INDEX IF EXISTS "SmartChargingState_chargerId_key";
