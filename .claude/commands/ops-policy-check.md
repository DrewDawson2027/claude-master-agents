Check if an action is allowed by team policy.

Usage: Provide the action and optionally the team ID.

Steps:
1. Ask user for the action to check (deploy, prod_push, force_push, destructive_delete)
2. Ask for team ID (optional)
3. Run: `python3 ~/.claude/scripts/policy_engine.py check-action --action {action} --team {team_id}`
4. Display the approval result
