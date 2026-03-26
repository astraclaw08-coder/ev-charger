#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
export MAESTRO_CLI_NO_ANALYTICS=1
maestro test e2e/task-map-controls-spacing-check.yaml --format junit --output e2e/reports/task-map-controls-spacing-check.xml
