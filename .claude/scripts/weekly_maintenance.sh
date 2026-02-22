#!/usr/bin/env zsh
set -euo pipefail

python3 ~/.claude/scripts/sync_marketplaces.py
python3 ~/.claude/scripts/pin_mcp_npx_versions.py --write
python3 ~/.claude/scripts/snapshot_lock.py
python3 ~/.claude/scripts/set_plugin_profile.py core-low-cost
python3 ~/.claude/scripts/trust_audit.py --quiet
python3 ~/.claude/scripts/cost_runtime.py index-refresh || true

# Team runtime weekly recover-hard sweep (non-fatal; produces a report).
mkdir -p ~/.claude/reports
WEEKLY_TEAM_REPORT=~/.claude/reports/team-recover-hard-weekly-$(date +%Y%m%d-%H%M%S).md
{
  echo "# Weekly Team Recover Hard Sweep"
  echo
  echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Auto-heal + GC dry-run executed before recover sweep."
  echo
} > "$WEEKLY_TEAM_REPORT"

{
  echo "## Preflight"
  echo
  echo "### SQLite Shadow Parity Audit"
  echo
  PARITY_JSON=$(python3 ~/.claude/scripts/team_runtime.py admin sqlite-parity --all --write-report --json 2>/tmp/team-sqlite-parity-weekly.err || echo '{"ok":false,"teamFailures":999999,"issueCount":999999,"error":"sqlite_parity_failed"}')
  printf '%s\n' "$PARITY_JSON" > /tmp/team-sqlite-parity-weekly.out
  PARITY_TEAM_FAILS=$(printf '%s' "$PARITY_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(d.get("teamFailures",0)))' 2>/dev/null || echo 999999)
  PARITY_ISSUES=$(printf '%s' "$PARITY_JSON" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(int(d.get("issueCount",0)))' 2>/dev/null || echo 999999)
  PARITY_GATE=$(python3 - <<'PY'
import json
from pathlib import Path
ff = Path.home()/".claude"/"governance"/"runtime-feature-flags.json"
defaults = {"sqlite_parity_gate_enabled": True, "sqlite_parity_max_team_failures": 0, "sqlite_parity_max_issue_count": 0}
try:
    d = json.loads(ff.read_text()) if ff.exists() else {}
except Exception:
    d = {}
for k,v in defaults.items():
    d.setdefault(k,v)
print(json.dumps({
    "enabled": bool(d.get("sqlite_parity_gate_enabled", True)),
    "maxTeamFailures": int(d.get("sqlite_parity_max_team_failures", 0)),
    "maxIssueCount": int(d.get("sqlite_parity_max_issue_count", 0))
}))
PY
)
  PARITY_GATE_ENABLED=$(printf '%s' "$PARITY_GATE" | python3 -c 'import sys,json; print("1" if json.load(sys.stdin).get("enabled") else "0")')
  PARITY_MAX_TEAM_FAILS=$(printf '%s' "$PARITY_GATE" | python3 -c 'import sys,json; print(int(json.load(sys.stdin).get("maxTeamFailures",0)))')
  PARITY_MAX_ISSUES=$(printf '%s' "$PARITY_GATE" | python3 -c 'import sys,json; print(int(json.load(sys.stdin).get("maxIssueCount",0)))')
  PRECHECK_SQLITE_PARITY_FAILED=0
  if [[ "$PARITY_GATE_ENABLED" == "1" ]] && { [[ "$PARITY_TEAM_FAILS" -gt "$PARITY_MAX_TEAM_FAILS" ]] || [[ "$PARITY_ISSUES" -gt "$PARITY_MAX_ISSUES" ]]; }; then
    PRECHECK_SQLITE_PARITY_FAILED=1
    echo "- Status: FAIL (threshold exceeded)"
  else
    echo "- Status: PASS"
  fi
  echo "- Team Failures: $PARITY_TEAM_FAILS (max=$PARITY_MAX_TEAM_FAILS)"
  echo "- Issue Count: $PARITY_ISSUES (max=$PARITY_MAX_ISSUES)"
  echo
  echo '```'
  tail -80 /tmp/team-sqlite-parity-weekly.out 2>/dev/null || true
  echo '```'
  echo
  echo "### Auto-Heal (One Shot)"
  echo
  if python3 ~/.claude/scripts/team_runtime.py team auto-heal --ensure-tmux > /tmp/team-auto-heal-weekly.out 2>&1; then
    echo "- Status: PASS"
  else
    echo "- Status: FAIL (continuing)"
  fi
  echo
  echo '```'
  tail -60 /tmp/team-auto-heal-weekly.out 2>/dev/null || true
  echo '```'
  echo
  echo "### GC (Dry Run)"
  echo
  if python3 ~/.claude/scripts/team_runtime.py team gc --dry-run --prune-tmux > /tmp/team-gc-weekly.out 2>&1; then
    echo "- Status: PASS"
  else
    echo "- Status: FAIL (continuing)"
  fi
  echo
  echo '```'
  tail -60 /tmp/team-gc-weekly.out 2>/dev/null || true
  echo '```'
  echo

  echo "### tmux Health Monitor"
  echo
  if python3 ~/.claude/scripts/team_runtime.py admin tmux-health --all > /tmp/team-tmux-health-weekly.out 2>&1; then
    echo "- Status: PASS"
  else
    echo "- Status: FAIL (continuing)"
  fi
  echo
  echo '```'
  tail -80 /tmp/team-tmux-health-weekly.out 2>/dev/null || true
  echo '```'
  echo

  echo "### Hook Watchdog"
  echo
  if python3 ~/.claude/scripts/team_runtime.py admin hook-watchdog > /tmp/team-hook-watchdog-weekly.out 2>&1; then
    echo "- Status: PASS"
  else
    echo "- Status: FAIL (continuing)"
  fi
  echo
  echo '```'
  tail -80 /tmp/team-hook-watchdog-weekly.out 2>/dev/null || true
  echo '```'
  echo
} >> "$WEEKLY_TEAM_REPORT"

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
    echo "## Team Selftests"
    echo
  } >> "$WEEKLY_TEAM_REPORT"

  while IFS= read -r TEAM_ID; do
    [[ -n "$TEAM_ID" ]] || continue
    {
      echo "### $TEAM_ID"
      echo
      echo "#### Checkpoint: $TEAM_ID"
      echo
      if python3 ~/.claude/scripts/team_runtime.py team checkpoint --team-id "$TEAM_ID" --label weekly-pre-recover > /tmp/team-checkpoint-$TEAM_ID.out 2>&1; then
        echo "- Checkpoint: PASS"
      else
        echo "- Checkpoint: FAIL (continuing)"
      fi
      echo
      echo '```'
      tail -40 /tmp/team-checkpoint-$TEAM_ID.out 2>/dev/null || true
      echo '```'
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

      echo "#### Selftest: $TEAM_ID"
      echo
      if python3 ~/.claude/scripts/team_runtime.py admin selftest --team-id "$TEAM_ID" > /tmp/team-selftest-$TEAM_ID.out 2>&1; then
        echo "- Selftest: PASS"
      else
        echo "- Selftest: FAIL (continuing)"
      fi
      echo
      echo '```'
      tail -60 /tmp/team-selftest-$TEAM_ID.out 2>/dev/null || true
      echo '```'
      echo
    } >> "$WEEKLY_TEAM_REPORT"
  done <<< "$ACTIVE_TEAMS"
fi

# Generate a higher-level weekly digest (non-fatal).
python3 ~/.claude/scripts/weekly_ops_digest.py >/tmp/weekly-ops-digest.path 2>/dev/null || true

if [[ "${PRECHECK_SQLITE_PARITY_FAILED:-0}" == "1" ]]; then
  echo "SQLite parity preflight threshold exceeded." >&2
  exit 2
fi
