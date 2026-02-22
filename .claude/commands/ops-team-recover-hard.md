# Team Recover Hard (Runbook)

Use this when a team looks stale, tmux/member state is inconsistent, or you want a one-command health + cost snapshot.

Primary tool:
- `coord_team_recover_hard team_id="my-team" ensure_tmux=true`

What it does:
- resume runtime
- reconcile tasks/events/workers
- run doctor checks
- render dashboard
- capture cost snapshot and write a snapshot file

After running:
- `coord_team_dashboard team_id="my-team"`
- `coord_team_check_events team_id="my-team" consumer="lead"`
