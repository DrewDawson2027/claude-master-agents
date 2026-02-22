#!/usr/bin/env bash
set -euo pipefail
CLAUDE_DIR="$HOME/.claude"
SCRIPTS="$CLAUDE_DIR/scripts"
REPORTS="$CLAUDE_DIR/reports"
mkdir -p "$REPORTS"
TS="$(date +%Y%m%d-%H%M%S)"
ISO_NOW() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
LOG="$REPORTS/cost-daily-automation-$TS.log"
{
  echo "[START] $(ISO_NOW) cost-daily-automation"
  python3 "$SCRIPTS/cost_runtime.py" index-refresh --json || true
  python3 "$SCRIPTS/cost_runtime.py" daily-report --window today --auto --json || true
  python3 "$SCRIPTS/cost_runtime.py" cost-trends --period week --json || true
  python3 "$SCRIPTS/cost_runtime.py" spend-leaderboard --window today --group-by team --json || true
  echo "[END] $(ISO_NOW) cost-daily-automation"
} >> "$LOG" 2>&1
ln -sf "$LOG" "$REPORTS/cost-daily-automation-latest.log"
