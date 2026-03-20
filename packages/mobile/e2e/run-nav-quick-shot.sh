#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
export MAESTRO_CLI_NO_ANALYTICS=1
maestro test e2e/task-nav-quick-shot.yaml --format junit --output e2e/reports/task-nav-quick-shot.xml
