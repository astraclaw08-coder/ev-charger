-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "maxChargeDurationMin" INTEGER,
ADD COLUMN     "maxIdleDurationMin" INTEGER,
ADD COLUMN     "maxSessionCostUsd" DOUBLE PRECISION;
