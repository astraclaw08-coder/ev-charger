-- Persist driver favorites by user in DB
CREATE TABLE IF NOT EXISTS "UserFavoriteCharger" (
  "userId" TEXT NOT NULL,
  "chargerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserFavoriteCharger_pkey" PRIMARY KEY ("userId", "chargerId")
);

CREATE INDEX IF NOT EXISTS "UserFavoriteCharger_userId_createdAt_idx"
  ON "UserFavoriteCharger"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "UserFavoriteCharger_chargerId_createdAt_idx"
  ON "UserFavoriteCharger"("chargerId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserFavoriteCharger_userId_fkey'
  ) THEN
    ALTER TABLE "UserFavoriteCharger"
      ADD CONSTRAINT "UserFavoriteCharger_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserFavoriteCharger_chargerId_fkey'
  ) THEN
    ALTER TABLE "UserFavoriteCharger"
      ADD CONSTRAINT "UserFavoriteCharger_chargerId_fkey"
      FOREIGN KEY ("chargerId") REFERENCES "Charger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
