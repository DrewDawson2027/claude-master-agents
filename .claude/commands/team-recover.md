# /team-recover

Recover a team in one command: resume runtime, reconcile state, then run doctor checks.

Primary tool:
- `coord_team_recover team_id="my-team" ensure_tmux=true`

Options:
- `coord_team_recover team_id="my-team" ensure_tmux=true keep_events=200 include_workers=true`

Follow-up:
- `coord_team_dashboard team_id="my-team"`
