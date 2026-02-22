# /team-boot-heavy

Create a team, start tmux, and spawn a larger default team for parallel execution.

Primary tool:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="heavy"`

Defaults spawned:
- `planner-1:planner`
- `coder-1:coder`
- `coder-2:coder`
- `reviewer-1:reviewer`
- `research-1:researcher`

Follow-up:
- `coord_team_dashboard team_id="my-team"`
- `coord_cost_team team_id="my-team" window="today" breakdown=true`
