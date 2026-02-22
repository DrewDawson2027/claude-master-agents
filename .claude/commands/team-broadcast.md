# /team-broadcast

Broadcast a message to teammates with priority and optional exclusions.

Primary tool:
- `coord_team_broadcast team_id="my-team" from_member="lead" content="Standup: status update in 5m" priority="high"`

Announcement mode:
- `coord_team_broadcast team_id="my-team" from_member="lead" content="Deploy freeze active" announcement=true include_lead=false`
