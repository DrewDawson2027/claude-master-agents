# /team-scale

Scale a running team to a preset without rebuild (spawn missing teammates, pause or stop extras).

Primary tools:
- `coord_team_scale_to_preset team_id="my-team" preset="lite"`
- `coord_team_scale_to_preset team_id="my-team" preset="standard"`
- `coord_team_scale_to_preset team_id="my-team" preset="heavy"`

Optional:
- `hard_downshift=true` to stop extra tmux panes instead of just pausing them.
