#!/usr/bin/env zsh
set -euo pipefail
mkdir -p ~/.claude/reports ~/.claude/logs
python3 ~/.claude/scripts/observability.py alerts evaluate --json >> ~/.claude/logs/observability-alert-loop.log 2>&1 || true
