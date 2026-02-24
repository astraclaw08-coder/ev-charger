#!/bin/bash
# Watches for phase completion and notifies via OpenClaw/Telegram
# Usage: ./watch-phase.sh 1

PHASE=$1
PROJECT_DIR=~/projects/ev-charger
TODO=$PROJECT_DIR/tasks/todo.md
CHECK_INTERVAL=30  # seconds

if [ -z "$PHASE" ]; then
  echo "Usage: $0 <phase_number>"
  exit 1
fi

echo "👀 Watching for Phase $PHASE completion... (checking every ${CHECK_INTERVAL}s)"

while true; do
  # Count unchecked items in the phase block
  IN_PHASE=0
  UNCHECKED=0
  CHECKED=0

  while IFS= read -r line; do
    if echo "$line" | grep -q "^## Phase $PHASE:"; then
      IN_PHASE=1
    elif echo "$line" | grep -q "^## Phase " && [ "$IN_PHASE" -eq 1 ]; then
      break
    fi
    if [ "$IN_PHASE" -eq 1 ]; then
      if echo "$line" | grep -q "^\- \[ \]"; then
        UNCHECKED=$((UNCHECKED + 1))
      elif echo "$line" | grep -q "^\- \[x\]"; then
        CHECKED=$((CHECKED + 1))
      fi
    fi
  done < "$TODO"

  TOTAL=$((CHECKED + UNCHECKED))

  if [ "$TOTAL" -gt 0 ]; then
    echo "[$(date '+%H:%M:%S')] Phase $PHASE: $CHECKED/$TOTAL tasks done"
  fi

  if [ "$TOTAL" -gt 0 ] && [ "$UNCHECKED" -eq 0 ]; then
    # Get last few commits
    COMMITS=$(cd "$PROJECT_DIR" && git log --oneline -3 2>/dev/null | head -3)

    MSG="✅ Phase $PHASE COMPLETE — ev-charger

All $CHECKED tasks checked off.

Recent commits:
$COMMITS

Head back to Astra to review and kick off Phase $((PHASE + 1))."

    # Notify via openclaw
    openclaw agent --to main --message "Deliver this to Son on Telegram: $MSG" --deliver 2>/dev/null
    echo "🎉 Phase $PHASE complete! Telegram notification sent."
    exit 0
  fi

  sleep $CHECK_INTERVAL
done
