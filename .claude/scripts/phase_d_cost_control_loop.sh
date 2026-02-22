#!/usr/bin/env bash
set -euo pipefail
CLAUDE_DIR="$HOME/.claude"
SCRIPTS="$CLAUDE_DIR/scripts"
REPORTS="$CLAUDE_DIR/reports"
mkdir -p "$REPORTS"
TS="$(date +%Y%m%d-%H%M%S)"
ISO_NOW() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
LOG="$REPORTS/phase-d-cost-control-loop-$TS.log"
{
  echo "[START] $(ISO_NOW) phase-d-cost-control-loop"
  python3 "$SCRIPTS/cost_runtime.py" index-refresh --json || true
  python3 "$SCRIPTS/cost_runtime.py" burn-rate-check --json || true
  python3 "$SCRIPTS/cost_runtime.py" anomaly-check --json || true
  python3 "$SCRIPTS/team_runtime.py" team auto-scale-loop --iterations 1 || true
  echo "[END] $(ISO_NOW) phase-d-cost-control-loop"
} >> "$LOG" 2>&1
ln -sf "$LOG" "$REPORTS/phase-d-cost-control-loop-latest.log"
