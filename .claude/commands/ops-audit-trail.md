Export audit trail of sensitive operations across all teams.

Steps:
1. Run: `python3 ~/.claude/scripts/observability.py audit-trail`
2. Display the trail showing: recovery actions, force claims, interrupts, replacements, archives
3. Optionally use `--hours N` to adjust the lookback window (default: 168h / 7 days)
