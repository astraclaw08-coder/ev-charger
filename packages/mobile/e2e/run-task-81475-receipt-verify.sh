#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
/Users/son/.maestro/bin/maestro test task-81475-receipt-verify.yaml --format junit --output reports/task-81475-receipt-verify.xml
