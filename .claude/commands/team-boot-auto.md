# /team-boot-auto

Create a team, start tmux, and auto-pick `lite` / `standard` / `heavy` based on current daily burn vs budget cap.

Primary tool:
- `coord_team_bootstrap name="my-team" cwd="/path/to/repo" preset="auto"`

Policy source:
- `/Users/drewdawson/.claude/cost/team-preset-profiles.json`

Useful follow-ups:
- `coord_cost_budget_status period="daily"`
- `coord_team_dashboard team_id="my-team"`
