-- Add cross-device user profile fields for mobile profile tab
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "homeAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "paymentProfile" TEXT;
