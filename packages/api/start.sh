#!/bin/bash
set -e
npx prisma migrate deploy --schema=packages/shared/prisma/schema.prisma
exec node packages/api/dist/index.js
