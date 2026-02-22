# /team-doctor

Run team runtime consistency checks (tmux, members, claims, events, cursors).

Primary tool:
- `coord_team_doctor team_id="my-team"`

Repair and cleanup helpers:
- `coord_team_resume team_id="my-team" ensure_tmux=true`
- `coord_team_reconcile team_id="my-team" include_workers=true`
