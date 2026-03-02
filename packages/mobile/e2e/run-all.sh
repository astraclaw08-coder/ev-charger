#!/bin/bash
# Run all Maestro e2e verification flows and report results
# Usage: ./e2e/run-all.sh [task-id]
#   e.g. ./e2e/run-all.sh task-0054   <- runs just that task
#        ./e2e/run-all.sh              <- runs all

export PATH="/opt/homebrew/opt/openjdk/bin:$PATH:$HOME/.maestro/bin"
export MAESTRO_CLI_NO_ANALYTICS=1

REPORT_DIR="e2e/reports/$(date +%Y-%m-%d_%H-%M)"
mkdir -p "$REPORT_DIR"

FILTER="${1:-}"
PASS=0
FAIL=0
FAILED_FLOWS=()

for flow in e2e/task-*.yaml; do
  name=$(basename "$flow" .yaml)
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    continue
  fi

  echo ""
  echo "▶ Running: $name"
  if maestro test "$flow" --format junit --output "$REPORT_DIR/$name.xml" 2>&1 | tail -5; then
    echo "✅ PASSED: $name"
    PASS=$((PASS + 1))
  else
    echo "❌ FAILED: $name"
    FAIL=$((FAIL + 1))
    FAILED_FLOWS+=("$name")
  fi
done

echo ""
echo "════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
if [[ ${#FAILED_FLOWS[@]} -gt 0 ]]; then
  echo "Failed: ${FAILED_FLOWS[*]}"
  exit 1
fi
