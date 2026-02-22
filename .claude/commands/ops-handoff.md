Create or view operator handoff snapshots for team transitions.

Usage:
- Create: `coord_collab_handoff_create` with team_id, from (operator name), note (optional context)
- View latest: `coord_collab_handoff_latest` with team_id to see "what changed since last handoff"

Steps:
1. Ask user: create new handoff or view latest?
2. For create: call coord_collab_handoff_create with team_id and from operator
3. For view: call coord_collab_handoff_latest with team_id
4. Display the handoff summary (task counts, member statuses, recent events, cost data)

Arguments: $ARGUMENTS (optional: team_id)
