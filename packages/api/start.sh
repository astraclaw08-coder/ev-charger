#!/bin/bash
set -e
echo "[Build verify] start.sh running — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[Build verify] reports.js exists: $(test -f packages/api/dist/routes/reports.js && echo YES || echo NO)"
npx prisma migrate deploy --schema=packages/shared/prisma/schema.prisma
exec node packages/api/dist/index.js
