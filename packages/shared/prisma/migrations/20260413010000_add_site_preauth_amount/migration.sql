-- TASK-0096 Phase 1: Add site-level preauth hold amount
ALTER TABLE "Site" ADD COLUMN "preauthAmountCents" INTEGER NOT NULL DEFAULT 5000;
