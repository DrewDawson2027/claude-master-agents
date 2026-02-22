Run auto-scale evaluation for a team based on queue depth, budget pressure, and SLO health.

Steps:
1. If no team_id provided, list available teams and ask
2. Run coord_auto_scale with team_id and dry_run=true first to preview the decision
3. Show the scaling decision, reasoning, and metrics
4. Ask user to confirm before applying (re-run without dry_run)

Arguments: $ARGUMENTS (optional: team_id)
