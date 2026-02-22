# /team-boot-lite

Create a team, start tmux, and spawn a low-cost default team (coder + reviewer).

Primary tool:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="lite"`

Defaults spawned:
- `coder-1:coder`
- `reviewer-1:reviewer`

Follow-up:
- `coord_team_dashboard team_id="my-team"`
