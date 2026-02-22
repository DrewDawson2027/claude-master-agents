# Troubleshooting Matrix

## Quick Reference

| Symptom | Likely Cause | Diagnostic Command | Fix |
|---------|-------------|-------------------|-----|
| Team won't boot | tmux missing | `which tmux` | `brew install tmux` |
| Team won't boot | No Python 3.10+ | `python3 --version` | Install Python 3.10+ |
| Team won't boot | Node < 18 | `node --version` | Update Node.js |
| Cost data empty | ccusage missing | `which ccusage` | Install ccusage |
| Cost data empty | No usage data yet | `/cost` | Wait for session activity |
| Parity grade < A | Missing tool/file | `python3 ~/.claude/scripts/parity_audit.py` | `claude-stack repair` |
| Parity grade < A | Deleted config | Check `governance/` directory | Restore from backup |
| Session frozen | Hung MCP call | `/team-doctor` | `/team-recover-hard` |
| Session frozen | Resource exhaustion | Check system memory | Kill heavy processes, restart |
| Session frozen | Hook loop | Check `~/.claude/settings.json` hooks | Disable problematic hook |
| Budget exceeded | Over daily limit | `/cost-budget` | Edit `cost/budgets.json` |
| Budget exceeded | Runaway agent | `/cost-team` | `/team-scale` to lite |
| Agent won't spawn | Token guard limit | Check agent count | Complete existing tasks first |
| Agent won't spawn | Budget exceeded | `/cost-budget` | Increase budget or wait |
| Member crash loop | Bad task | Check events log | Remove/skip the task |
| Member crash loop | MCP server down | Check MCP readiness | Restart MCP server |
| tmux session lost | System restart | `tmux ls` | `/team-auto-heal` |
| tmux session lost | Terminal crash | `tmux ls` | `/team-recover-hard` |
| Tasks stuck blocked | Circular dependency | `/ops-team-tasks` | Remove blocking dependency |
| Tasks stuck blocked | Blocker never completes | `/team-dashboard` | Reassign or skip blocker |
| Messages not delivered | Inbox overflow | Check `messages.jsonl` size | Archive old messages |
| Handoff fails | No team dir | Check `~/.claude/teams/{id}/` exists | Verify team ID |
| Policy lint fails | Bad config format | `/ops-policy-lint` | Fix JSON syntax errors |
| Policy lint fails | Missing required file | Check lint output | Create missing governance file |
| Scale fails | Already at target | Check current preset | No action needed |
| Scale fails | Budget insufficient | `/cost-budget` | Increase budget first |
| Auto-recover loops | Persistent issue | Check events for pattern | Fix root cause manually |
| Weekly report empty | No data in window | Check events.jsonl timestamps | Wait for more activity |
| Bundle fails | Missing files | `claude-stack verify-bundle` | Run `claude-stack repair` first |
| MCP coordinator crash | Syntax error in index.js | `node --check ~/.claude/mcp-coordinator/index.js` | Fix JavaScript syntax |
| MCP coordinator crash | Missing dependency | `cd ~/.claude/mcp-coordinator && npm ls` | `npm install` |
| Hook blocked | token-guard rejection | Read the block message | Follow Tool Ladder |
| Hook blocked | read-efficiency-guard | Batch reads into parallel | Use Grep first |

## Diagnostic Commands

### System Health
```bash
# Full system check
~/.claude/scripts/claude-stack status

# Parity audit
python3 ~/.claude/scripts/parity_audit.py

# Trust audit
python3 ~/.claude/scripts/trust_audit.py

# Cost doctor
python3 ~/.claude/scripts/cost_doctor.py
```

### Team Health
```bash
# Team doctor
python3 ~/.claude/scripts/team_runtime.py team doctor --team {id}

# Team dashboard
python3 ~/.claude/scripts/team_runtime.py team dashboard --team {id}

# Event timeline
python3 ~/.claude/scripts/observability.py timeline --team {id}

# SLO metrics
python3 ~/.claude/scripts/observability.py slo --team {id}
```

### Cost Health
```bash
# Cost summary
python3 ~/.claude/scripts/cost_runtime.py summary

# Budget status
python3 ~/.claude/scripts/cost_runtime.py budget

# Team cost rollup
python3 ~/.claude/scripts/cost_runtime.py team --team {id}
```

## Log Locations

| Log | Path | Format |
|-----|------|--------|
| Team events | `~/.claude/teams/{id}/events.jsonl` | JSON lines |
| Team messages | `~/.claude/teams/{id}/messages.jsonl` | JSON lines |
| Comments | `~/.claude/teams/{id}/comments.jsonl` | JSON lines |
| SLO history | `~/.claude/reports/slo-history.jsonl` | JSON lines |
| Parity audit | `~/.claude/reports/parity-audit-latest.json` | JSON |
| Weekly reports | `~/.claude/reports/weekly-optimize-*.md` | Markdown |
| Handoff snapshots | `~/.claude/teams/{id}/handoffs/` | JSON + Markdown |
| Cost cache | `~/.claude/cost/cache.json` | JSON |

## Getting Help

- System health: `/system-health`
- Team doctor: `/team-doctor`
- Full health report: `/ops-health-report`
- Report issues: https://github.com/anthropics/claude-code/issues
