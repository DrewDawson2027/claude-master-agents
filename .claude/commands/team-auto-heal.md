# /team-auto-heal

Auto-heal active teams by reconciling and respawning broken pane teammates.

One-shot:
- `coord_team_auto_heal ensure_tmux=true`

Single team:
- `coord_team_auto_heal team_id="my-team" ensure_tmux=true`

Daemon loop (advanced):
- `coord_team_auto_heal ensure_tmux=true daemon=true interval_seconds=60 iterations=10`
