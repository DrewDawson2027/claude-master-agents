# /team-gc

Garbage collect stale team artifacts (orphan mailboxes, stale cursors, optional orphan tmux sessions).

Dry run first:
- `coord_team_gc dry_run=true prune_tmux=true`

Apply cleanup:
- `coord_team_gc prune_tmux=true cursor_age_days=30`
