-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'REJECTED');

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "reservationId" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "connectorRefId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "holdStartsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "holdExpiresAt" TIMESTAMP(3) NOT NULL,
    "ocppSent" BOOLEAN NOT NULL DEFAULT false,
    "ocppAccepted" BOOLEAN,
    "fulfilledSessionId" TEXT,
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- Add reservation settings to Site
ALTER TABLE "Site" ADD COLUMN "reservationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "reservationMaxDurationMin" INTEGER NOT NULL DEFAULT 30;

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_reservationId_key" ON "Reservation"("reservationId");
CREATE UNIQUE INDEX "Reservation_fulfilledSessionId_key" ON "Reservation"("fulfilledSessionId");
CREATE INDEX "Reservation_userId_status_idx" ON "Reservation"("userId", "status");
CREATE INDEX "Reservation_connectorRefId_status_idx" ON "Reservation"("connectorRefId", "status");
CREATE INDEX "Reservation_siteId_status_idx" ON "Reservation"("siteId", "status");
CREATE INDEX "Reservation_holdExpiresAt_status_idx" ON "Reservation"("holdExpiresAt", "status");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_connectorRefId_fkey" FOREIGN KEY ("connectorRefId") REFERENCES "Connector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
