# /team-watch

Live-refresh workflow for terminal operators.

Recommended shell loop:
```bash
watch -n 5 'python3 ~/.claude/scripts/team_runtime.py team dashboard --team-id my-team'
```

Claude-side alternative:
- re-run `coord_team_dashboard team_id="my-team"` after major events
