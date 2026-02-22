# Collaborator Onboarding

## Objective
Get a collaborator to a stable, low-cost default in under 5 minutes.

## Steps
1. Ensure Claude config exists at `~/.claude`.
2. Run:
   - `~/.claude/scripts/claude-stack install`
   - `~/.claude/scripts/claude-stack doctor`
3. Optional for niche tasks:
   - Search catalog: `python3 ~/.claude/scripts/plugin_catalog_search.py <keyword>`
   - Enable temporary extra plugin via profile extras.

## Team Runtime Quickstart
1. Create/start a team:
   - `python3 ~/.claude/scripts/team_runtime.py team bootstrap --name my-team --cwd /path/to/repo --teammate dev1:coder --teammate rev1:reviewer`
2. In Claude, use:
   - `coord_team_dashboard`
   - `coord_team_scale_to_preset` / `coord_team_broadcast`
   - `coord_team_restart_member` / `coord_team_replace_member`
   - `coord_team_clone` / `coord_team_archive` / `coord_team_gc`
   - `coord_team_auto_heal` for one-shot repair on active teams
   - `coord_team_add_task` / `coord_team_claim_task` / `coord_team_update_task`
   - `coord_team_doctor` / `coord_team_resume` for recovery
   - `coord_team_recover_hard` for one-command recovery + dashboard + cost snapshot
   - `coord_team_recover_hard_all` for active-team sweeps
   - `coord_team_selftest` for health verification
3. Cost visibility:
   - `/cost` equivalent via `coord_cost_summary`
   - compact live line appears in inbox hook via `cost_runtime.py hook-statusline`
   - team rollup via `coord_cost_team`

## Operating Model
- Daily work: `core-low-cost` profile.
- Official updates: weekly via `~/.claude/scripts/weekly_maintenance.sh`.
- Wrapper entrypoint: `~/.claude/scripts/claude-stack {doctor|install|update}`.
- Team runtime health sweep: weekly maintenance runs `recover-hard` on active teams and writes a report.
- Weekly preflight also runs `auto-heal` (one-shot) and `gc --dry-run`.
- Weekly ops digest: generated under `~/.claude/reports/weekly-ops-digest-*.md`.
- Community plugins: Tier 2 approval + pin + smoke test.
- Monthly cleanup report: `~/.claude/scripts/monthly_purge.sh`.
- Parity audit: `python3 ~/.claude/scripts/parity_audit.py`
