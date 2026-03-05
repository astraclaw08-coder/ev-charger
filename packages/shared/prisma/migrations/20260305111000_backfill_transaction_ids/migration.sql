-- Backfill transactionId for historical completed sessions that are missing one.
-- Keeps existing transactionId values and assigns new unique integers after current max.

WITH base AS (
  SELECT COALESCE(MAX("transactionId"), 0) AS max_tid
  FROM "Session"
),
missing AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn
  FROM "Session"
  WHERE "status" = 'COMPLETED' AND "transactionId" IS NULL
)
UPDATE "Session" s
SET "transactionId" = b.max_tid + m.rn
FROM missing m
CROSS JOIN base b
WHERE s.id = m.id;
