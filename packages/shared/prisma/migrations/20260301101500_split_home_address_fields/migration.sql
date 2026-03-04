-- Split profile home address into separate fields for mobile UX
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "homeSiteAddress" TEXT,
  ADD COLUMN IF NOT EXISTS "homeCity" TEXT,
  ADD COLUMN IF NOT EXISTS "homeState" TEXT,
  ADD COLUMN IF NOT EXISTS "homeZipCode" TEXT;
