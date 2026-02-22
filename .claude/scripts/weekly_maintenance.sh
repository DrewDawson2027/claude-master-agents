#!/usr/bin/env zsh
set -euo pipefail

python3 ~/.claude/scripts/sync_marketplaces.py
python3 ~/.claude/scripts/pin_mcp_npx_versions.py --write
python3 ~/.claude/scripts/snapshot_lock.py
python3 ~/.claude/scripts/set_plugin_profile.py core-low-cost
python3 ~/.claude/scripts/trust_audit.py --quiet

# Team runtime weekly recover-hard sweep (non-fatal; produces a report).
mkdir -p ~/.claude/reports
WEEKLY_TEAM_REPORT=~/.claude/reports/team-recover-hard-weekly-$(date +%Y%m%d-%H%M%S).md
{
  echo "# Weekly Team Recover Hard Sweep"
  echo
  echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
} > "$WEEKLY_TEAM_REPORT"

ACTIVE_TEAMS=$(python3 - <<'PY'
import json
from pathlib import Path
root = Path.home() / ".claude" / "teams"
if not root.exists():
    raise SystemExit(0)
for d in sorted(root.iterdir()):
    if not d.is_dir():
        continue
    cfg = d / "config.json"
    rt = d / "runtime.json"
    if not cfg.exists() or not rt.exists():
        continue
    try:
        state = (json.loads(rt.read_text()) or {}).get("state")
    except Exception:
        state = None
    if state == "running":
        print(d.name)
PY
)

if [[ -z "${ACTIVE_TEAMS}" ]]; then
  {
    echo "## Result"
    echo
    echo "- No active teams found."
  } >> "$WEEKLY_TEAM_REPORT"
else
  {
    echo "## Active Teams"
    echo
    while IFS= read -r TEAM_ID; do
      [[ -n "$TEAM_ID" ]] && echo "- $TEAM_ID"
    done <<< "$ACTIVE_TEAMS"
    echo
    echo "## Recover Hard Results"
    echo
  } >> "$WEEKLY_TEAM_REPORT"

  while IFS= read -r TEAM_ID; do
    [[ -n "$TEAM_ID" ]] || continue
    {
      echo "### $TEAM_ID"
      echo
      if python3 ~/.claude/scripts/team_runtime.py team recover-hard --team-id "$TEAM_ID" --include-workers --snapshot-window today --cost-timeout 20 > /tmp/team-recover-hard-$TEAM_ID.out 2>&1; then
        echo "- Status: PASS"
      else
        echo "- Status: FAIL (continuing)"
      fi
      echo
      echo '```'
      tail -80 /tmp/team-recover-hard-$TEAM_ID.out 2>/dev/null || true
      echo '```'
      echo
    } >> "$WEEKLY_TEAM_REPORT"
  done <<< "$ACTIVE_TEAMS"
fi
