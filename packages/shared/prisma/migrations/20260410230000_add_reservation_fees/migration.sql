-- Add reservation fee settings to Site
ALTER TABLE "Site" ADD COLUMN "reservationFeeUsd" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Site" ADD COLUMN "reservationCancelGraceMin" INTEGER NOT NULL DEFAULT 5;

-- Add fee tracking fields to Reservation
ALTER TABLE "Reservation" ADD COLUMN "feeAmountCents" INTEGER;
ALTER TABLE "Reservation" ADD COLUMN "feeStripePaymentIntentId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "feeStatus" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "feeCancelGraceExpiresAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN "feeRefundedAt" TIMESTAMP(3);
