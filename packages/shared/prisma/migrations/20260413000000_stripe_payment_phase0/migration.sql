-- TASK-0096 Phase 0: Stripe Payment Infrastructure
-- Adds User.stripeCustomerId, PaymentPurpose enum, expanded PaymentStatus,
-- and restructures Payment model for preauth/capture flow.

-- ============================================================================
-- 1. New enum: PaymentPurpose
-- ============================================================================
CREATE TYPE "PaymentPurpose" AS ENUM ('CHARGING', 'RESERVATION', 'REMAINDER', 'REFUND_ADJUSTMENT');

-- ============================================================================
-- 2. Expand PaymentStatus enum with new states
-- ============================================================================
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REQUIRES_ACTION';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CAPTURE_IN_PROGRESS';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL_CAPTURED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CANCELED';

-- ============================================================================
-- 3. User: add stripeCustomerId
-- ============================================================================
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;

-- ============================================================================
-- 4. Backfill User.stripeCustomerId from Payment table
--    Only trust values that match Stripe customer ID format (cus_...)
-- ============================================================================
UPDATE "User" u
SET "stripeCustomerId" = sub."stripeCustomerId"
FROM (
  SELECT DISTINCT ON ("userId") "userId", "stripeCustomerId"
  FROM "Payment"
  WHERE "stripeCustomerId" IS NOT NULL
    AND "stripeCustomerId" LIKE 'cus_%'
  ORDER BY "userId", "createdAt" DESC
) sub
WHERE u."id" = sub."userId"
  AND u."stripeCustomerId" IS NULL;

-- ============================================================================
-- 5. Payment model: restructure for preauth/capture flow
-- ============================================================================

-- Drop the old unique constraint on sessionId (allows multiple payments per session)
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "Payment_sessionId_fkey";
DROP INDEX IF EXISTS "Payment_sessionId_key";

-- Make sessionId nullable (preauth created before session exists)
ALTER TABLE "Payment" ALTER COLUMN "sessionId" DROP NOT NULL;

-- Add new columns
ALTER TABLE "Payment" ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'CHARGING';
ALTER TABLE "Payment" ADD COLUMN "connectorRefId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "preauthToken" TEXT;
ALTER TABLE "Payment" ADD COLUMN "authorizedCents" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "deficitCents" INTEGER;

-- Add unique constraint on preauthToken (for precise preauth→session matching)
CREATE UNIQUE INDEX "Payment_preauthToken_key" ON "Payment"("preauthToken");

-- Add unique constraint on stripeIntentId (prevents double-capture)
CREATE UNIQUE INDEX "Payment_stripeIntentId_key" ON "Payment"("stripeIntentId");

-- Add indexes for common query patterns
CREATE INDEX "Payment_sessionId_idx" ON "Payment"("sessionId");
CREATE INDEX "Payment_connectorRefId_userId_status_idx" ON "Payment"("connectorRefId", "userId", "status");
CREATE INDEX "Payment_preauthToken_idx" ON "Payment"("preauthToken");

-- Re-add foreign key with SET NULL behavior (session deletion shouldn't orphan payment records)
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- 6. Clean up dead columns from prior schema changes
-- ============================================================================
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleMake";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleModel";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleName";
ALTER TABLE "User" DROP COLUMN IF EXISTS "vehicleYear";
ALTER TABLE "SessionBillingSnapshot" DROP COLUMN IF EXISTS "receiptSentAt";
