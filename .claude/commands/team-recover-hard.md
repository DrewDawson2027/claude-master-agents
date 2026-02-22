# /team-recover-hard

Hard recovery in one command: resume + reconcile + doctor + dashboard + cost snapshot (and write a recovery snapshot file).

Primary tool:
- `coord_team_recover_hard team_id="my-team" ensure_tmux=true`

Options:
- `coord_team_recover_hard team_id="my-team" ensure_tmux=true snapshot_window="today" cost_timeout=30`
- `coord_team_recover_hard team_id="my-team" ensure_tmux=true keep_events=200 include_workers=true`

Outputs:
- Runtime recovery result
- Team dashboard
- Cost snapshot summary
- Snapshot file path under `~/.claude/teams/<team>/recover-hard-snapshot-*.json`
