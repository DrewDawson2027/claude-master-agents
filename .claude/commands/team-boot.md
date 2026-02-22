# /team-boot

Create a team, start the tmux runtime, and spawn a standard teammate set in one shot.

Primary tool:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo"`

Default teammates (spawned automatically if `teammates` is omitted):
- `coder-1:coder`
- `reviewer-1:reviewer`
- `research-1:researcher`

Presets:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="lite"`
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="standard"`
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="heavy"`
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="auto"` (budget-aware)

Bootstrap is idempotent for pane-backed defaults: rerunning will skip teammates that already have panes instead of spawning duplicates.

Optional override:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" teammates=["dev1:coder","qa1:reviewer"]`

Useful follow-ups:
- `coord_team_dashboard team_id="my-team"`
- `coord_team_add_task`
- `coord_team_claim_task`
- `coord_team_update_task`
- `coord_team_teardown team_id="my-team" kill_panes=true`
