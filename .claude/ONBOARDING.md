# Collaborator Onboarding

## Objective
Get a collaborator to a stable, low-cost default in under 5 minutes.

## Steps
1. Ensure Claude config exists at `~/.claude`.
2. Run:
   - `python3 ~/.claude/scripts/set_plugin_profile.py core-low-cost`
   - `python3 ~/.claude/scripts/trust_audit.py`
   - `python3 ~/.claude/scripts/snapshot_lock.py`
   - `python3 ~/.claude/scripts/cost_doctor.py`
   - `bash ~/.claude/scripts/parity_smoke.sh`
3. Optional for niche tasks:
   - Search catalog: `python3 ~/.claude/scripts/plugin_catalog_search.py <keyword>`
   - Enable temporary extra plugin via profile extras.

## Team Runtime Quickstart
1. Create/start a team:
   - `python3 ~/.claude/scripts/team_runtime.py team bootstrap --name my-team --cwd /path/to/repo --teammate dev1:coder --teammate rev1:reviewer`
2. In Claude, use:
   - `coord_team_dashboard`
   - `coord_team_add_task` / `coord_team_claim_task` / `coord_team_update_task`
   - `coord_team_doctor` / `coord_team_resume` for recovery
   - `coord_team_recover_hard` for one-command recovery + dashboard + cost snapshot
3. Cost visibility:
   - `/cost` equivalent via `coord_cost_summary`
   - compact live line appears in inbox hook via `cost_runtime.py hook-statusline`
   - team rollup via `coord_cost_team`

## Operating Model
- Daily work: `core-low-cost` profile.
- Official updates: weekly via `~/.claude/scripts/weekly_maintenance.sh`.
- Team runtime health sweep: weekly maintenance runs `recover-hard` on active teams and writes a report.
- Community plugins: Tier 2 approval + pin + smoke test.
- Monthly cleanup report: `~/.claude/scripts/monthly_purge.sh`.
- Parity audit: `python3 ~/.claude/scripts/parity_audit.py`
