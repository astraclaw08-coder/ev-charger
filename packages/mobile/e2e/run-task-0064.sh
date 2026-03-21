#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
export MAESTRO_CLI_NO_ANALYTICS=1
maestro test e2e/task-0064-confirm-dark-login-before-shot.yaml --format junit --output e2e/reports/task-0064-confirm-dark-login-before-shot.xml
