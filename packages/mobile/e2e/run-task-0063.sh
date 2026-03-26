#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
export MAESTRO_CLI_NO_ANALYTICS=1
mkdir -p e2e/reports
maestro test e2e/task-0063-capture-app-error.yaml --format junit --output e2e/reports/task-0063-capture-app-error.xml
