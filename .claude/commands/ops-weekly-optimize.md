Generate weekly optimization recommendations for team resource usage.

Steps:
1. If team_id provided, run coord_auto_weekly_optimize for that team
2. If --all or no team specified, run for all teams
3. Display the optimization report: cost per task, model usage, wasted spend, recommendations
4. Report saved to ~/.claude/reports/weekly-optimize-{team}-{timestamp}.md

Arguments: $ARGUMENTS (optional: team_id or --all)
